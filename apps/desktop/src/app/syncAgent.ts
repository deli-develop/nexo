import {
  SYNC_INTERVAL_MS,
  flushOutbox,
  listConversations,
  syncAll,
  type SyncResult,
} from "../lib/conversations";
import { drainStream, onEnvelope } from "../lib/stream";
import { setTrayUnread, toastMessage } from "../lib/native";
import { totalUnread, useApp, isMuted } from "./store";

/**
 * The one sync loop (M8).
 *
 * Exactly one place calls `sync_all`, and this is it. Sync consumes envelopes:
 * whoever pulls them is the only one who learns they arrived, so two competing
 * pollers would each see half the arrivals and the unread counts would lie.
 * Everything that used to poll for itself now subscribes here instead.
 *
 * Each pass is: flush the offline queue, then sync. Flush first because that
 * is what "delivers on reconnect" means — the moment the network is back, the
 * queue drains before anything else is asked of the connection. Being offline
 * fails the flush quietly and leaves the queue where it was; that is the state
 * the queue exists for, not an error.
 */

export type SyncListener = (result: SyncResult) => void;

const listeners = new Set<SyncListener>();
let inFlight: Promise<SyncResult | null> | null = null;

/** Subscribe to completed sync passes. Returns the unsubscribe. */
export function onSync(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the agent decides to do about one conversation's new messages. */
export interface ArrivalDecision {
  /** Add to the unread ledger and the tray count. */
  countUnread: boolean;
  /** Show a toast, through the privacy setting in Rust. */
  toast: boolean;
}

/**
 * The rule for one arrival. Pure, and separated from the plumbing so it can be
 * tested: getting this wrong in one direction spams toasts for a conversation
 * the person is looking at, and in the other silently swallows messages.
 */
export function arrivalDecision(input: {
  conversationId: string;
  activeConversationId: string;
  onMessagesRoute: boolean;
  windowFocused: boolean;
  muted: boolean;
}): ArrivalDecision {
  // "Being read right now" is all three at once: this conversation, on the
  // Messages page, in a focused window. Anything less and the person has not
  // seen the message, whatever the UI happens to have rendered.
  const beingRead =
    input.windowFocused &&
    input.onMessagesRoute &&
    input.conversationId === input.activeConversationId;
  if (beingRead) return { countUnread: false, toast: false };
  // Muted silences the toast, not the count: mute means "stop interrupting
  // me", and hiding the badge too would turn it into "lose my messages".
  return { countUnread: true, toast: !input.muted };
}

/**
 * Runs one flush-then-sync pass now. Concurrent calls share the pass that is
 * already running rather than racing it.
 */
export function syncNow(): Promise<SyncResult | null> {
  if (!inFlight) {
    inFlight = pass().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function pass(): Promise<SyncResult | null> {
  const state = useApp.getState();
  // Locked means the Rust side has dropped the store; there is nothing to
  // sync into and every call would just report "signed out".
  if (!state.account || state.locked) return null;

  try {
    await flushOutbox();
  } catch {
    // Offline, signed out, or a browser preview: the queue keeps waiting.
  }

  let result: SyncResult;
  try {
    result = await syncAll();
  } catch {
    return null;
  }

  await handleArrivals(result);
  for (const listener of listeners) listener(result);
  return result;
}

async function handleArrivals(result: SyncResult): Promise<void> {
  const arrivals = result.arrivals.filter((a) => a.messages > 0);
  if (arrivals.length === 0) return;

  const state = useApp.getState();
  const windowFocused = typeof document !== "undefined" && document.hasFocus();
  // One reading of the clock for the whole batch. Two arrivals a millisecond
  // apart must not land on opposite sides of a mute that is expiring.
  const now = Date.now();

  const decisions = arrivals.map((arrival) => ({
    arrival,
    decision: arrivalDecision({
      conversationId: arrival.conversation_id,
      // An open team board is read the way an open conversation is: what
      // arrives on it while it is on screen is not unread.
      activeConversationId:
        state.route === "teams" ? state.activeTeamId : state.activeConversationId,
      onMessagesRoute: state.route === "messages" || state.route === "teams",
      windowFocused,
      muted: isMuted(state.conversationOverrides[arrival.conversation_id], now),
    }),
  }));

  for (const { arrival, decision } of decisions) {
    if (decision.countUnread) state.addUnread(arrival.conversation_id, arrival.messages);
  }

  const toasting = decisions.filter(({ decision }) => decision.toast);
  if (toasting.length === 0) return;

  // Titles come from the list the core already keeps. The toast's body is the
  // newest message; Rust applies the privacy setting before anything reaches
  // the OS, so passing it here does not decide what gets shown.
  const detail = state.preferences.notificationDetail;
  const conversations = await listConversations().catch(() => []);
  for (const { arrival } of toasting) {
    const conversation = conversations.find(
      (c) => c.conversation_id === arrival.conversation_id,
    );
    await toastMessage(
      conversation?.title ?? "Someone",
      conversation?.last_message ?? "",
      detail,
    );
  }
}

/**
 * Starts the periodic loop. Returns the stop function.
 *
 * Mounted once, by the app shell. Also listens for the network coming back —
 * that is the reconnect in "delivers on reconnect", and waiting up to a full
 * poll interval to notice it would be an eternity next to the event.
 */
/**
 * How often the live socket is drained.
 *
 * Far shorter than the sync interval, and it costs nothing to be: this is a
 * `try_recv` on a channel in Rust, not a request. Four seconds is far too slow
 * for "is somebody typing right now", which is the one thing the socket carries
 * that is only true for a few seconds at a time.
 */
const STREAM_DRAIN_MS = 500;

/**
 * How long an arrival waits for its neighbours before it triggers a sync.
 *
 * The socket announces one event per envelope, and a lively group produces
 * them in bursts — a commit, three messages, a reaction. Syncing on each would
 * mean four round trips where one would do. A quarter of a second is short
 * enough to be invisible on a ringing call and long enough to collect a burst.
 */
const ARRIVAL_COALESCE_MS = 250;

export function startSyncAgent(): () => void {
  const timer = window.setInterval(() => void syncNow(), SYNC_INTERVAL_MS);

  // The live socket rides on this loop rather than owning a timer of its own.
  //
  // It is also what opens the socket: `drain_stream` connects when there is a
  // session and disconnects when there is not, so signing in, locking and
  // signing out all take care of themselves without `auth.rs` knowing sockets
  // exist. A second, faster timer is what makes typing feel live — four
  // seconds is far too slow for "is someone typing right now".
  const streamTimer = window.setInterval(() => {
    void drainStream().catch(() => {
      // The socket is allowed to fail; the poll above is what keeps the app
      // correct. Nothing here is worth telling anybody about.
    });
  }, STREAM_DRAIN_MS);
  const onOnline = () => void syncNow();
  window.addEventListener("online", onOnline);

  // An arrival means "there is something to fetch", so fetch it rather than
  // waiting out the poll. Coalesced, because a burst of envelopes is one sync's
  // worth of work and the socket reports each of them separately.
  let arrivalTimer: number | undefined;
  const stopEnvelopes = onEnvelope(() => {
    if (arrivalTimer !== undefined) return;
    arrivalTimer = window.setTimeout(() => {
      arrivalTimer = undefined;
      void syncNow();
    }, ARRIVAL_COALESCE_MS);
  });

  // Focus is when "unread" can become "read": returning to the window while a
  // conversation is open means its messages are now on a screen someone is
  // looking at.
  const onFocus = () => {
    const state = useApp.getState();
    if (state.route === "messages") state.clearUnread(state.activeConversationId);
  };
  window.addEventListener("focus", onFocus);

  // The tray mirrors the ledger whatever changes it — an arrival here, a
  // conversation opened anywhere else.
  const unsubscribe = useApp.subscribe((state, previous) => {
    if (state.unread !== previous.unread) {
      void setTrayUnread(totalUnread(state.unread));
    }
  });

  void syncNow();

  return () => {
    window.clearInterval(timer);
    window.clearInterval(streamTimer);
    if (arrivalTimer !== undefined) window.clearTimeout(arrivalTimer);
    void stopEnvelopes.then((stop) => stop()).catch(() => {});
    window.removeEventListener("online", onOnline);
    window.removeEventListener("focus", onFocus);
    unsubscribe();
  };
}
