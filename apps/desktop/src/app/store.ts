import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Account } from "../lib/auth";
import type { BackdropReport } from "../lib/native";

export type Route = "home" | "messages" | "profile" | "settings";

/**
 * What a person has decided about one conversation.
 *
 * `mutedUntil` is a timestamp rather than a flag, so "mute for an hour" is the
 * same mechanism as "mute" and not a second one bolted beside it. `Infinity`
 * is the honest way to say "until I say otherwise": it compares correctly
 * against `Date.now()` without a special case, and `JSON.stringify` turns it
 * into `null`, which is why the reader below treats a missing number as
 * "muted, no end" rather than as "not muted".
 */
export interface ConversationOverride {
  mutedUntil?: number | null;
  pinned?: boolean;
  /**
   * Out of the way without being gone.
   *
   * Distinct from muting, which is about interruption, and from removing, which
   * is about the history: an archived conversation still notifies and still
   * exists, it simply is not in the list you look at all day. A conversation
   * that receives a message stays archived — unarchiving on arrival would make
   * the feature useless for the one case it exists for, which is a chat that
   * keeps talking and that you have finished with.
   */
  archived?: boolean;
}

/**
 * Whether a conversation is muted at this moment.
 *
 * Pure and exported, because the sync agent and the list have to agree about
 * it: one decides whether to interrupt someone, the other draws the bell, and
 * a disagreement between them is a person being interrupted by a conversation
 * that says it is silent.
 */
export function isMuted(override: ConversationOverride | undefined, now: number): boolean {
  if (!override || !("mutedUntil" in override)) return false;
  const until = override.mutedUntil;
  // `null` is what `Infinity` becomes on the way through JSON. Both mean the
  // same thing here: muted with no end.
  if (until === null || until === undefined) return true;
  return until > now;
}

/**
 * UI state.
 *
 * Deliberately only UI state. Zustand holds what the chrome needs to draw
 * itself — which page is open, which conversation is selected, which panels
 * are showing — and nothing that would be a secret. Message plaintext arrives
 * from Rust over IPC and lives in component state for as long as it is on
 * screen (rule 2). Feed and profile data become TanStack Query cache at M7.
 *
 * Only `preferences` persists (M8), through localStorage. Everything else is
 * rebuilt on launch, which is the point: a route or a selected conversation
 * is session state, and preferences are the settings a person chose and
 * expects to find again. Nothing persisted here is a secret — the encrypted
 * store on the Rust side holds those, and WebView storage never does.
 */
/**
 * §6.4 asked for dark only in v0.1 with "a theme seam in place". The seam is
 * now used: every surface, line and fill is a named token, so a theme is a
 * different set of values under the same names and no component knows which
 * one it is in. "System" follows the OS through prefers-color-scheme, which is
 * the absence of an explicit choice rather than a third palette.
 */
export type Theme = "system" | "light" | "dark";

/** §8: minutes of idleness before the app locks, or never. */
export type LockTimeout = "never" | "5" | "15" | "60";

export interface Preferences {
  theme: Theme;
  /**
   * Plan risk 9: `backdrop-filter` is expensive on integrated GPUs and some
   * people turn transparency off in Windows. The opaque fallback is a real
   * setting, not just an @supports branch.
   */
  glass: boolean;
  /**
   * N14: the accent, as a hue in degrees.
   *
   * A hue rather than a colour: §7.4 asks for 4.5:1, and a freely chosen RGB
   * value fails that as often as it passes. Fixing saturation and lightness
   * and letting only the hue move keeps every accent as legible as the violet
   * it replaces.
   */
  accentHue: number;
  /**
   * N15: how far the background goes toward black, 0 to 1.
   *
   * 0 is the palette as designed; 1 is pure black in dark mode and pure white
   * in light. Every surface moves by the same proportion, so the steps between
   * panels survive at the far end.
   */
  contrast: number;
  /**
   * N16: how strong the glass blur is, 0 to 1.
   *
   * Zero is a real off, not a blur of nothing: `backdrop-filter` costs the GPU
   * whatever its radius, which is the entire reason `glass` was a switch
   * (plan risk 9). At zero the property is dropped rather than set to 0px.
   */
  glassStrength: number;
  /**
   * Which desktop backdrop to ask Windows for.
   *
   * A choice rather than something the app works out, and that is deliberate.
   * Whether a backdrop becomes visible depends on the Windows build, on the
   * machine's graphics, and on how the window was created -- and from Windows
   * 11 build 22523 on, the API that sets it does not report failure. So the app
   * asks for what it is told to ask for and says so; the person in front of the
   * window is the only one who can see the answer.
   *
   * `acrylic` blurs live content behind the window. `mica` tints from the
   * wallpaper and does *not* change when something moves behind the app.
   */
  backdrop: "off" | "acrylic" | "mica" | "tabbed" | "blur";
  readReceipts: boolean;
  typingIndicators: boolean;
  presence: boolean;
  /** §4.5: previews are generated client-side and are off by default. */
  linkPreviews: boolean;
  /** §8: what a Windows toast is allowed to say. */
  notificationDetail: "full" | "sender" | "none";
  /**
   * §8: auto-lock after this much idleness. The timer is `useAutoLock`; the
   * locking is `lockSession` in `lib/auth.ts`, which says what it does and
   * does not guarantee — it guards the screen, not the disk.
   */
  lockTimeout: LockTimeout;
  /**
   * §8: whether the unlock-PIN offer has been answered on this machine.
   *
   * True once somebody has either set a PIN from the offer or waved it past,
   * so the question is asked once rather than at every sign-in. It exists
   * because the PIN used to be a *gate* — the app would not open until one
   * existed — which charged a screen for a convenience and charged it again on
   * the sign-in after every sign-out, since signing out erases the PIN.
   *
   * Deliberately *not* reset by signing out. Signing out does erase the PIN,
   * so the machine genuinely has none afterwards — but re-arming the offer on
   * that fact is what put "Choose an unlock PIN" in front of the very next
   * sign-in, which is the thing the offer was made skippable to stop doing.
   * Asked once per machine means once; Settings sets a PIN at any time after.
   */
  pinOfferAnswered: boolean;
  /**
   * §8: closing the window hides to the tray instead of quitting. Off by
   * default — an app that keeps running after being closed has surprised its
   * user. The value is pushed to Rust, where the close handler lives.
   */
  closeToTray: boolean;
  /**
   * Whether this machine relays Nexo traffic for people who cannot reach it
   * (`docs/RELAY.md`). Off by default, and nothing but the person turns it
   * on: it opens a port to the internet, and it can be noticed. `App` starts
   * the relay at launch when this is on; the shell holds whether it runs.
   */
  relay: boolean;
  /**
   * The port the relay listens on. Kept while the relay is off, so turning it
   * back on reuses the port the router was already told about.
   */
  relayPort: number;
  /**
   * Whether Home keeps the most recent conversation beside the feed.
   *
   * On by default: the feed column is 660px wide, so on any window that fits
   * the panel there was empty margin doing nothing. Off gives the feed the
   * whole width, which is the right answer on a narrow window or for someone
   * who wants to read without a conversation in the corner of their eye.
   */
  homeChat: boolean;
  /**
   * How wide that conversation panel is, in pixels.
   *
   * A preference rather than a fixed number because the right answer depends
   * on the monitor and on what the person is doing: reading the feed with a
   * conversation in the corner of the eye wants a narrow panel, answering
   * someone while half-watching the feed wants a wide one. The splitter on
   * Home writes this when the drag ends.
   *
   * Bounds are enforced where it is used, not here: the ceiling is whatever
   * is left after the feed keeps its minimum, and that depends on the window.
   */
  homeChatWidth: number;
}

export const defaultPreferences: Preferences = {
  theme: "system",
  glass: true,
  // The blue the app is built around, as a hue. `useChrome` writes this to
  // `--accent-hue` on the root, so this value -- not the token's default --
  // is what the app actually wears. Somebody who already picked a hue keeps
  // it: this is the default, not an override.
  accentHue: 213,
  contrast: 0,
  glassStrength: 1,
  backdrop: "acrylic",
  readReceipts: true,
  typingIndicators: true,
  presence: true,
  linkPreviews: false,
  notificationDetail: "sender",
  lockTimeout: "15",
  pinOfferAnswered: false,
  closeToTray: false,
  relay: false,
  relayPort: 41731,
  homeChat: true,
  homeChatWidth: 380,
};

interface AppState {
  /**
   * The signed-in account.
   *
   * Identity, not credentials: a handle, a display name, and two ids. No
   * token, no key, nothing MLS knows about (rule 2) -- the same four fields
   * the sign-in screen already put on the screen. It lives here because the
   * feed, the profile, and the composer all need to know who "you" are, and
   * threading it through four levels of props to get there is how a prop ends
   * up being passed to somewhere it should not go.
   *
   * `null` before the session is restored, and again after signing out.
   */
  account: Account | null;
  /**
   * The signed-in person's avatar, as an object key.
   *
   * Kept beside the account rather than on it: `Account` is what the Rust side
   * hands back when a session is restored, and it carries identity, not
   * decoration. This changes whenever the picture does, which is why the post
   * composer used to draw a generated identicon while every post underneath it
   * showed the real face -- the composer had no way to know, and nothing was
   * going to tell it.
   *
   * `null` means no avatar set, or not loaded yet. Both draw the fallback.
   */
  myAvatarKey: string | null;
  /**
   * §8: whether the app is locked. `lockSession` does the dropping — the
   * tokens and the MLS state, from memory — and this flag only decides that
   * the lock screen is what gets drawn.
   */
  locked: boolean;
  route: Route;
  /**
   * Whose profile the Profile tab is showing.
   *
   * `null` means your own. Set when a handle is clicked anywhere, and cleared
   * by the rail — going to Profile from the rail means *your* profile, which
   * is what that button has always meant.
   */
  viewingHandle: string | null;
  /**
   * Whether the in-conversation search bar is open.
   *
   * Opened by the header's magnifier and by `Ctrl+F`, closed by `Esc`. Not
   * persisted: a search box that is still open tomorrow is a search box
   * somebody forgot about.
   */
  conversationSearchOpen: boolean;
  activeConversationId: string;
  /** User intent for the context panel, before the viewport gets a say. */
  contextPanelOpen: boolean;
  /** The feed's search box, opened from the Home title row. */
  homeSearchQuery: string;
  /**
   * What Windows said when the desktop backdrop was last asked for.
   *
   * Session state, not a preference: it describes what happened, not what
   * anyone chose. Settings prints it beside the chooser so the answer is a
   * fact on the screen rather than something the app quietly assumed.
   */
  backdropReport: BackdropReport | null;
  /**
   * Per-conversation choices, kept apart from the conversation data itself so
   * that flipping one never mutates what came from the store.
   *
   * **Persisted**, unlike almost everything else here. Muting a conversation
   * and finding it loud again after a restart is not a setting, it is a
   * suggestion — and pinning that forgets itself is worse than no pinning. The
   * unread ledger next door is deliberately *not* persisted, and the
   * difference is the point: this is what a person decided, that is what the
   * server happened to deliver.
   */
  conversationOverrides: Record<string, ConversationOverride>;
  /**
   * Unread incoming messages per conversation (§8).
   *
   * Fed by the sync agent from each sync's arrivals, cleared when the
   * conversation is actually on screen. Not persisted: on a restart the
   * history is there to read, and a stale badge that survives it would claim
   * unread messages nobody can find.
   */
  unread: Record<string, number>;
  /**
   * Where the "unread messages" line goes, per conversation.
   *
   * How many incoming messages were still unread at the moment the
   * conversation was opened — which is the last moment anyone knows, because
   * opening it is what marks them read. Without this the line could not exist:
   * by the time the list renders, the count it would need is already zero.
   *
   * Not persisted, and for the same reason the ledger next door is not: on a
   * restart there is nothing anybody has failed to read, and a line claiming
   * otherwise would point at a boundary that no longer means anything.
   */
  unreadMark: Record<string, number>;
  preferences: Preferences;
  setAccount: (account: Account | null) => void;
  setMyAvatarKey: (key: string | null) => void;
  setLocked: (locked: boolean) => void;
  go: (route: Route) => void;
  /** Opens somebody's profile. `null` opens your own. */
  viewProfile: (handle: string | null) => void;
  openConversation: (id: string) => void;
  /** Close the open conversation. On a phone this is what Back does. */
  closeConversation: () => void;
  toggleContextPanel: () => void;
  setConversationSearch: (open: boolean) => void;
  setHomeSearchQuery: (query: string) => void;
  setBackdropReport: (report: BackdropReport) => void;
  toggleConversationFlag: (id: string, flag: "pinned" | "archived") => void;
  /** `until` is a timestamp, or `null` to unmute. `Infinity` never expires. */
  muteConversation: (id: string, until: number | null) => void;
  /** Drops every choice made about a conversation that no longer exists. */
  forgetConversation: (id: string) => void;
  addUnread: (id: string, count: number) => void;
  clearUnread: (id: string) => void;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      account: null,
      myAvatarKey: null,
      locked: false,
      route: "messages",
      viewingHandle: null,
      conversationSearchOpen: false,
      activeConversationId: "",
      contextPanelOpen: true,
      homeSearchQuery: "",
      backdropReport: null,
      conversationOverrides: {},
      unread: {},
      unreadMark: {},
      preferences: defaultPreferences,
      // Signing out drops the picture along with the identity it belonged to;
      // leaving it would show the last person's face to the next one.
      setAccount: (account) =>
        set(account ? { account } : { account: null, myAvatarKey: null }),
      setMyAvatarKey: (myAvatarKey) => set({ myAvatarKey }),
      setLocked: (locked) => set({ locked }),
      go: (route) =>
        // Clearing the handle is the point: the rail's Profile button means
        // your own profile, and leaving somebody else's there would make it
        // mean "whoever you last looked at".
        set({ route, viewingHandle: null }),
      viewProfile: (handle) =>
        set((s) => ({
          route: "profile",
          // Your own handle opens *your* profile, not a read-only view of
          // yourself -- which offered a Message button that started a
          // conversation with your own account.
          viewingHandle:
            handle && handle.toLowerCase() === s.account?.handle.toLowerCase()
              ? null
              : handle,
            })),
      openConversation: (id) =>
        set((s) => {
          // Last visit's line goes. `clearUnread` draws a new one a moment
          // later if there is anything to draw it for.
          const { [id]: _gone, ...unreadMark } = s.unreadMark;
          return {
            activeConversationId: id,
                  conversationSearchOpen: false,
            unreadMark,
          };
        }),
      closeConversation: () =>
        set({ activeConversationId: "", conversationSearchOpen: false }),
      toggleContextPanel: () => set((s) => ({ contextPanelOpen: !s.contextPanelOpen })),
      setConversationSearch: (open) => set({ conversationSearchOpen: open }),
      setHomeSearchQuery: (query) => set({ homeSearchQuery: query }),
      toggleConversationFlag: (id, flag) =>
        set((s) => {
          const current = s.conversationOverrides[id] ?? {};
          const next = current[flag] ?? false;
          return {
            conversationOverrides: {
              ...s.conversationOverrides,
              [id]: { ...current, [flag]: !next },
            },
          };
        }),
      muteConversation: (id, until) =>
        set((s) => {
          const { [id]: current, ...rest } = s.conversationOverrides;
          if (until === null) {
            // Unmuting drops the key rather than storing `undefined`, so an
            // override that holds nothing else stops taking up space in the
            // persisted blob.
            const { mutedUntil: _drop, ...kept } = current ?? {};
            return Object.keys(kept).length === 0
              ? { conversationOverrides: rest }
              : { conversationOverrides: { ...rest, [id]: kept } };
          }
          return {
            conversationOverrides: {
              ...s.conversationOverrides,
              [id]: { ...(current ?? {}), mutedUntil: until },
            },
          };
        }),
      forgetConversation: (id) =>
        set((s) => {
          const { [id]: _override, ...overrides } = s.conversationOverrides;
          const { [id]: _unread, ...unread } = s.unread;
          return {
            conversationOverrides: overrides,
            unread,
            // A conversation that is gone cannot stay open behind the list.
            activeConversationId: s.activeConversationId === id ? "" : s.activeConversationId,
          };
        }),
      addUnread: (id, count) =>
        set((s) => ({
          unread: { ...s.unread, [id]: (s.unread[id] ?? 0) + count },
        })),
      clearUnread: (id) =>
        set((s) => {
          if (!(id in s.unread)) return s;
          const { [id]: count, ...rest } = s.unread;
          // Reading them is what fixes where the line goes, so this is the
          // one moment it can be recorded. Kept only while the conversation
          // stays open -- `openConversation` drops it on the way back in.
          const unreadMark =
            count && count > 0 ? { ...s.unreadMark, [id]: count } : s.unreadMark;
          return { unread: rest, unreadMark };
        }),
      setBackdropReport: (backdropReport) => set({ backdropReport }),
      setPreference: (key, value) =>
        set((s) => ({ preferences: { ...s.preferences, [key]: value } })),
    }),
    {
      // Only the preferences survive a restart (M8). `merge` keeps defaults
      // for keys a stored blob from an older build does not have, so adding a
      // preference never resets the ones already chosen.
      name: "nexo-preferences",
      partialize: (state) => ({
        preferences: state.preferences,
        conversationOverrides: state.conversationOverrides,
      }),
      merge: (persisted, current) => {
        const blob =
          persisted && typeof persisted === "object"
            ? (persisted as {
                preferences?: Partial<Preferences>;
                conversationOverrides?: Record<string, ConversationOverride>;
              })
            : {};
        return {
          ...current,
          preferences: { ...current.preferences, ...blob.preferences },
          // Merged by hand like the preferences, and for the same reason: a
          // blob written by an older build has no key for whatever was added
          // since, and spreading `current` first is what keeps the defaults
          // instead of erasing them.
          conversationOverrides: {
            ...current.conversationOverrides,
            ...blob.conversationOverrides,
          },
        };
      },
    },
  ),
);

/** Every unread message across every conversation, for the rail and the tray. */
export function totalUnread(unread: Record<string, number>): number {
  return Object.values(unread).reduce((total, count) => total + count, 0);
}
