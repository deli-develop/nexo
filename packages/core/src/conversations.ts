import type { CryptoModule, Device, Group } from "./crypto";
import { TransportError } from "./errors";
import {
  decodePayload,
  encodePayload,
  isReactionEmoji,
  payloadId,
  preview,
  type Payload,
} from "./payload";
import { Store, type StoredConversation, type StoredMessage } from "./store";
import type { Transport } from "./transport";
import type {
  Accepted,
  ClaimedKeyPackage,
  ConversationSummary,
  Envelope,
  KeyPackageCount,
} from "./types";

/**
 * Conversations: starting them, sending into them, and catching up.
 *
 * A port of the load-bearing half of `crates/client/src/conversations.rs`. Two
 * rules shape every function below, and both exist because getting them wrong
 * is silent.
 *
 * # A commit can lose, so it is staged
 *
 * The delivery service orders commits and the first writer wins. A client that
 * applied its own commit optimistically would believe it had moved to an epoch
 * nobody else is in, and **every message it sent afterwards would be
 * unreadable to everyone** — permanently, because MLS will not decrypt those
 * envelopes a second time.
 *
 * So the order is always: build the commit, send it, and only then
 * `confirmCommit` if the server took it or `abandonCommit` if it did not.
 *
 * # The ratchet moves even when nothing is stored
 *
 * Encrypting advances it. If the provider is not written back afterwards, the
 * next start replays an older ratchet and the group falls out of step with
 * everybody in it. Every operation here persists on **both** paths, the
 * failure one included, which is why none of them is a plain getter.
 */

export interface Context {
  transport: Transport;
  store: Store;
  crypto: CryptoModule;
  device: Device;
  /** Injectable so a test can pin time. Defaults to the wall clock. */
  now?: () => number;
  /** Injectable for the same reason. Defaults to `crypto.randomUUID`. */
  uuid?: () => string;
}

const clock = (ctx: Context): number => (ctx.now ?? Date.now)();
const uuid = (ctx: Context): string => (ctx.uuid ?? (() => globalThis.crypto.randomUUID()))();

/** Saves the MLS provider, which every operation below owes on its way out. */
async function persist(ctx: Context): Promise<void> {
  await ctx.store.setMlsState(ctx.device.exportState());
}

// ------------------------------------------------------------- key packages

/**
 * Publishes KeyPackages so other people can start conversations with us.
 *
 * Each one is **single-use** — an invitation consumes it — so running out
 * means nobody can reach this device, and the person it happens to sees no
 * error at all because nothing *they* do fails. That is why this is called at
 * registration and again whenever the count runs low, rather than only when
 * something visibly breaks.
 */
export async function publishKeyPackages(ctx: Context, count: number): Promise<number> {
  const keyPackages: string[] = [];
  for (let i = 0; i < count; i += 1) keyPackages.push(toHex(ctx.device.keyPackage()));
  // Saved before the send, not after: generating a package wrote its private
  // half into the provider, and a package published to the server that this
  // device has no private half for is one nobody can ever use to reach us.
  await persist(ctx);
  await ctx.transport.postAuth<unknown>("/v1/keypackages", { key_packages: keyPackages });
  return keyPackages.length;
}

/** What the server still holds for this device, and the threshold it sets. */
export function keyPackageCount(ctx: Context): Promise<KeyPackageCount> {
  return ctx.transport.getAuth<KeyPackageCount>("/v1/keypackages/count");
}

/**
 * Tops up if the server says the supply is low. Returns how many were added.
 *
 * The threshold is the server's, not a constant here: it is the side that can
 * see how fast they are being consumed.
 */
export async function refillKeyPackagesIfLow(ctx: Context): Promise<number> {
  const { remaining, refill_below } = await keyPackageCount(ctx);
  if (remaining >= refill_below) return 0;
  return publishKeyPackages(ctx, Math.max(refill_below * 2 - remaining, 1));
}

// ------------------------------------------------------------------ starting

/**
 * Starts a conversation with somebody, or adopts the one that already exists.
 *
 * The ordering is the whole function, and it is not the obvious one:
 *
 * 1. claim their KeyPackage — spending it, so this cannot be retried blindly;
 * 2. build the group locally and stage the add commit;
 * 3. register the conversation **before** sending the commit, because a commit
 *    for a conversation the server has never heard of is refused;
 * 4. send the commit, and only once that is accepted, confirm it locally;
 * 5. send the Welcome — as an ordinary envelope, because the invitee is
 *    already a member server-side and the conversation's own stream is the
 *    delivery path. There is no second endpoint and no need for one.
 *
 * Step 5 is the one that looks skippable and is not. Without the Welcome the
 * other person can fetch every envelope in the conversation and holds the key
 * to none of them.
 */
export async function startWith(ctx: Context, handle: string): Promise<string> {
  const claimed = await ctx.transport.getAuth<ClaimedKeyPackage>(
    `/v1/keypackages/${encodeURIComponent(handle)}`,
  );

  const conversationId = uuid(ctx);
  const group = ctx.crypto.createGroup(ctx.device, conversationId, clock(ctx));
  const staged = group.addMember(ctx.device, fromHex(claimed.key_package));

  // Everything above is local and costs nothing if it fails. Everything below
  // leaves a row on the server whether or not the rest works.
  let created: ConversationSummary;
  try {
    created = await ctx.transport.postAuth<ConversationSummary>("/v1/conversations", {
      conversation_id: conversationId,
      members: [handle],
    });
  } catch (error) {
    group.abandonCommit(ctx.device);
    await persist(ctx);
    throw error;
  }

  // The server may answer with a *different* conversation: there is one DM per
  // pair of people, and if they started theirs a moment earlier, that is the
  // one that exists. Adopt it. The group built above is thrown away unused —
  // the way into theirs is the Welcome their commit already sent to one of our
  // KeyPackages, which arrives on the next sync.
  if (created.conversation_id !== conversationId) {
    group.abandonCommit(ctx.device);
    await persist(ctx);
    await remember(ctx, created, handle);
    return created.conversation_id;
  }

  const epochBefore = Number(group.epoch);
  try {
    await ctx.transport.postAuth<Accepted>(`/v1/conversations/${conversationId}/send`, {
      ciphertext: toHex(staged.message),
      epoch: epochBefore,
      is_commit: true,
      client_msg_id: uuid(ctx),
    });
  } catch (error) {
    group.abandonCommit(ctx.device);
    await persist(ctx);
    throw error;
  }

  const epoch = Number(group.confirmCommit(ctx.device, clock(ctx)));

  // Saved here, not at the end. Until this line the group exists only in the
  // provider's memory, and a failure below would lose it while leaving the
  // conversation, its membership row and this commit standing on the server —
  // a chat both people can see, neither can send to, and no retry repairs,
  // because the way in was a Welcome that was never sent.
  await persist(ctx);
  await remember(ctx, { ...created, epoch }, handle);

  if (staged.welcome) {
    // A failure here is real but survivable: the commit is on the server, so
    // the conversation exists and a later repair can send a fresh Welcome.
    await ctx.transport.postAuth<Accepted>(`/v1/conversations/${conversationId}/send`, {
      ciphertext: toHex(staged.welcome),
      epoch,
      is_commit: false,
      client_msg_id: uuid(ctx),
    });
  }

  return conversationId;
}

/**
 * Opens the conversation with somebody, starting one only if there is none.
 *
 * This exists rather than calling [`startWith`] directly because a KeyPackage
 * is single-use and a group is created per call: "message this person" wired
 * straight to `startWith` makes a new conversation every time it is pressed —
 * an endless list of identical empty chats, one spent KeyPackage each.
 *
 * The server's membership list is the authority, not the local store: the
 * other person may have started it, in which case this device has a
 * conversation it never created and must not duplicate.
 */
export async function openWith(ctx: Context, handle: string): Promise<string> {
  const wanted = handle.trim().toLowerCase();
  const listed = await ctx.transport.getAuth<ConversationSummary[]>("/v1/conversations");
  const me = (await ctx.store.account())?.handle.toLowerCase();
  const forgotten = await ctx.store.forgottenConversations();
  let dead: string | undefined;

  for (const summary of listed) {
    if (summary.kind !== "dm") continue;
    const others = summary.members.map((member) => member.toLowerCase())
      .filter((member) => member !== me);
    if (others.length !== 1 || others[0] !== wanted) continue;

    const id = summary.conversation_id;
    const hasEnvelopes = summary.latest_envelope_id !== null;
    let joined = ctx.crypto.loadGroup(ctx.device, id, clock(ctx)) !== undefined;
    let syncedBeforeOpen = false;

    // An envelope is not proof of a usable chat: it may be a commit whose
    // Welcome never arrived. Sync once before deciding which it is.
    if (hasEnvelopes && !joined) {
      const resume = forgotten.get(id) ?? 0;
      await ctx.store.rememberConversation(id);
      await remember(ctx, summary, wanted);
      if (resume > 0) {
        const local = await ctx.store.conversation(id);
        if (local) await ctx.store.putConversation({ ...local, syncedTo: resume });
      }
      await sync(ctx, id);
      syncedBeforeOpen = true;
      joined = ctx.crypto.loadGroup(ctx.device, id, clock(ctx)) !== undefined;
      if (!joined) {
        // The server's routing membership cannot grant an MLS group. Leaving
        // it is the only way out of a DM whose Welcome will never arrive.
        if (me) {
          try {
            await ctx.transport.postAuth<void>(`/v1/conversations/${id}/members/remove`, {
              handle: me,
            });
          } catch {
            // A failed leave will surface when creation is handed this same
            // dead DM back; it must not hide a usable later candidate here.
          }
        }
        await ctx.store.forgetConversation(id);
        continue;
      }
    }

    // An empty registration with no local group is a half-created leftover.
    // Keep looking: an older usable DM may be behind it in the server list.
    if (!hasEnvelopes && !joined) {
      dead ??= id;
      continue;
    }

    // A deliberate open lifts a local removal and resumes after its old
    // cursor. Replaying the deleted history would undo "remove for me".
    const resume = forgotten.get(id) ?? 0;
    if (forgotten.has(id) && !syncedBeforeOpen) {
      await ctx.store.rememberConversation(id);
    }
    await remember(ctx, summary, wanted);
    if (resume > 0 && !syncedBeforeOpen) {
      const local = await ctx.store.conversation(id);
      if (local) await ctx.store.putConversation({ ...local, syncedTo: resume });
    }
    return id;
  }

  if (dead) {
    if (await ctx.store.conversation(dead)) await ctx.store.forgetConversation(dead);
    try {
      await ctx.transport.deleteAuth(`/v1/conversations/${dead}`);
    } catch {
      // Only a conversation without envelopes can be discarded. A race that
      // added one will be resolved when `startWith` gets the settled id back.
    }
  }
  return startWith(ctx, wanted);
}

export const SELF_TITLE = "Saved messages";

/** A one-member MLS group for notes kept on this device. */
export async function startSelf(ctx: Context): Promise<string> {
  const existing = (await ctx.store.conversations()).find((row) => row.kind === "self");
  if (existing) return existing.id;

  const id = uuid(ctx);
  ctx.crypto.createGroup(ctx.device, id, clock(ctx));
  const created = await ctx.transport.postAuth<ConversationSummary>("/v1/conversations", {
    conversation_id: id,
    members: [],
  });
  // The server keeps one self conversation per account, including two starts
  // that raced. Adopt its id rather than persisting a second local row.
  await persist(ctx);
  await remember(ctx, created, SELF_TITLE);
  return created.conversation_id;
}

/**
 * Claims every one-use KeyPackage before creating a group. Each member gets a
 * separate commit and Welcome, and every accepted commit is persisted before
 * the next network call can fail.
 */
export async function startGroup(
  ctx: Context,
  handles: string[],
  title: string,
): Promise<string> {
  if (handles.length === 0) {
    throw new TransportError("rejected", "Choose at least one person for the group.");
  }
  const packages: Uint8Array[] = [];
  for (const handle of handles) {
    const claimed = await ctx.transport.getAuth<ClaimedKeyPackage>(
      `/v1/keypackages/${encodeURIComponent(handle)}`,
    );
    packages.push(fromHex(claimed.key_package));
  }

  const id = uuid(ctx);
  const group = ctx.crypto.createGroup(ctx.device, id, clock(ctx));
  const created = await ctx.transport.postAuth<ConversationSummary>("/v1/conversations", {
    conversation_id: id,
    members: handles,
  });
  if (created.conversation_id !== id) {
    throw new TransportError("rejected", "The server returned a different group id.");
  }

  for (const keyPackage of packages) {
    const staged = group.addMember(ctx.device, keyPackage);
    try {
      await sendEnvelope(ctx, id, staged.message, Number(group.epoch), true);
    } catch (error) {
      group.abandonCommit(ctx.device);
      await persist(ctx);
      throw error;
    }
    const epoch = Number(group.confirmCommit(ctx.device, clock(ctx)));
    await persist(ctx);
    await remember(ctx, { ...created, epoch });
    if (staged.welcome) await sendEnvelope(ctx, id, staged.welcome, epoch, false);
  }

  // A name is content: the server does not know it. Send only after the last
  // member joined, because earlier ciphertext cannot be read by a later one.
  const ciphertext = group.encrypt(ctx.device, encodePayload({ kind: "rename", title }));
  await persist(ctx); // encrypt advanced the ratchet, even if send fails
  await sendEnvelope(ctx, id, ciphertext, Number(group.epoch), false);
  await remember(ctx, { ...created, epoch: Number(group.epoch) }, title);
  return id;
}

/** Routing membership first, then the MLS commit, then the Welcome. */
export async function addTo(ctx: Context, conversationId: string, handle: string): Promise<void> {
  const group = requireGroup(ctx, conversationId);
  const claimed = await ctx.transport.getAuth<ClaimedKeyPackage>(
    `/v1/keypackages/${encodeURIComponent(handle)}`,
  );
  await ctx.transport.postAuth<void>(`/v1/conversations/${conversationId}/members`, { handle });
  const staged = group.addMember(ctx.device, fromHex(claimed.key_package));
  try {
    await sendEnvelope(ctx, conversationId, staged.message, Number(group.epoch), true);
  } catch (error) {
    group.abandonCommit(ctx.device);
    await persist(ctx);
    throw error;
  }
  const epoch = Number(group.confirmCommit(ctx.device, clock(ctx)));
  await persist(ctx);
  const local = await ctx.store.conversation(conversationId);
  if (local) {
    await ctx.store.putConversation({
      ...local,
      kind: group.memberCount > 2 ? "group" : local.kind,
      epoch,
    });
  }
  if (staged.welcome) await sendEnvelope(ctx, conversationId, staged.welcome, epoch, false);
}

async function sendEnvelope(
  ctx: Context,
  conversationId: string,
  ciphertext: Uint8Array,
  epoch: number,
  isCommit: boolean,
): Promise<Accepted> {
  return ctx.transport.postAuth<Accepted>(`/v1/conversations/${conversationId}/send`, {
    ciphertext: toHex(ciphertext),
    epoch,
    is_commit: isCommit,
    client_msg_id: uuid(ctx),
  });
}

// ------------------------------------------------------------------- sending

/**
 * Sends one payload, and writes it to history once the server has it.
 *
 * Never the other way round: a message written into history that the server
 * refused is a message the sender believes arrived.
 *
 * On an unreachable network the ciphertext goes to the outbox instead and the
 * answer is `null`. It is already encrypted — the queue holds no plaintext —
 * and it keeps the `client_msg_id` it was built with, so a retry after a lost
 * reply is answered with the envelope the first attempt made rather than
 * turning into a second copy in everybody's conversation.
 */
export async function sendPayload(
  ctx: Context,
  conversationId: string,
  payload: Payload,
): Promise<number | null> {
  const group = requireGroup(ctx, conversationId);
  const ciphertext = group.encrypt(ctx.device, encodePayload(payload));
  const epoch = Number(group.epoch);
  const clientMsgId = payloadId(payload) ?? uuid(ctx);

  // Before the send, unconditionally: the ratchet has already moved.
  await persist(ctx);

  let accepted: Accepted;
  try {
    accepted = await ctx.transport.postAuth<Accepted>(
      `/v1/conversations/${conversationId}/send`,
      { ciphertext: toHex(ciphertext), epoch, is_commit: false, client_msg_id: clientMsgId },
    );
  } catch (error) {
    if (error instanceof TransportError && error.kind === "unreachable") {
      await ctx.store.enqueue({
        conversationId,
        ciphertext: toHex(ciphertext),
        epoch,
        isCommit: false,
        clientMsgId,
        queuedAtMs: clock(ctx),
      });
      return null;
    }
    throw error;
  }

  await applyOwn(ctx, conversationId, payload, accepted.envelope_id, clientMsgId, clock(ctx));
  return accepted.envelope_id;
}

/** The ordinary case: send some words. */
export function send(ctx: Context, conversationId: string, body: string): Promise<number | null> {
  return sendPayload(ctx, conversationId, { kind: "text", body, id: uuid(ctx) });
}

/** Answers one message with another. */
export function reply(
  ctx: Context,
  conversationId: string,
  target: string,
  body: string,
): Promise<number | null> {
  return sendPayload(ctx, conversationId, { kind: "reply", body, target, id: uuid(ctx) });
}

/**
 * Renames a conversation, for everyone in it.
 *
 * Sent as an ordinary encrypted message rather than written to the server:
 * what people call their group is content, and the server holds no title
 * column for it to leak. Every member applies it on sync, so the name
 * converges without anybody having to own it.
 */
export async function rename(ctx: Context, conversationId: string, title: string): Promise<void> {
  await sendPayload(ctx, conversationId, { kind: "rename", title });
}

/** Reacts to a message, or takes the reaction back. */
export async function react(
  ctx: Context,
  conversationId: string,
  target: string,
  emoji: string,
  on: boolean,
): Promise<void> {
  if (!isReactionEmoji(emoji)) {
    throw new TransportError("rejected", "That is not something that can go in a reaction.");
  }
  await sendPayload(ctx, conversationId, { kind: "reaction", target, emoji, on });
}

/**
 * Takes back one of our own messages, or changes what it says.
 *
 * Both are the same act with different content, so they share a path. What
 * goes out is a *request*: a well-behaved Nexo applies it, a modified one need
 * not, and the UI has to say so rather than promise an unsend.
 */
export async function revise(
  ctx: Context,
  conversationId: string,
  target: string,
  body: string | null,
): Promise<void> {
  const message = await ctx.store.messageByClientId(conversationId, target);
  if (!message) throw new TransportError("not_found", "There is no such message here.");
  if (message.senderDeviceId !== null) {
    throw new TransportError("rejected", "That is somebody else's message.");
  }
  const at = clock(ctx);
  if (!senderMayChange(message.sentAtMs, at)) {
    throw new TransportError("rejected", "That message is too old to change.");
  }
  await sendPayload(
    ctx,
    conversationId,
    body === null
      ? { kind: "retract", target }
      : { kind: "edit", target, body, edited_at_ms: at },
  );
}

/**
 * Flushes the outbox, oldest first.
 *
 * Order matters and is not decoration: these were encrypted in sequence, and
 * MLS tolerates bounded reordering rather than arbitrary reordering. An entry
 * the server refuses outright is dropped — retrying it for ever would block
 * everything behind it — and one that fails on the network stops the flush
 * where it is, so the next attempt resumes from the same place.
 */
export async function flushOutbox(ctx: Context): Promise<number> {
  let sent = 0;
  for (const entry of await ctx.store.outbox()) {
    try {
      await ctx.transport.postAuth<Accepted>(`/v1/conversations/${entry.conversationId}/send`, {
        ciphertext: entry.ciphertext,
        epoch: entry.epoch,
        is_commit: entry.isCommit,
        client_msg_id: entry.clientMsgId,
      });
    } catch (error) {
      if (error instanceof TransportError && error.kind === "unreachable") break;
      await ctx.store.dequeue(entry.id);
      continue;
    }
    await ctx.store.dequeue(entry.id);
    sent += 1;
  }
  return sent;
}

// ---------------------------------------------------------------- catching up

/** What one sync pass did. Every envelope lands in exactly one of these. */
export interface SyncOutcome {
  messages: number;
  commits: number;
  /** Envelopes this device was never meant to read. Not a failure. */
  skipped: number;
  /** Envelopes that would not decrypt. Reported, never hidden. */
  failed: number;
  /** Set when a Welcome in this pass put this device into the conversation. */
  joined: boolean;
}

/**
 * Pulls everything new for one conversation and applies it in order.
 *
 * Two passes, and the reason is not tidiness: a Welcome further down the batch
 * is what makes the rest of the batch readable, so joins happen before
 * anything that depends on membership. Joining also fixes the epoch —
 * everything at or before the Welcome is history this device was never part
 * of, which MLS is explicit about, and which is *skipped* rather than counted
 * as a failure. Counting it would raise "a message could not be read" on every
 * new conversation somebody is invited to.
 */
export async function sync(ctx: Context, conversationId: string): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { messages: 0, commits: 0, skipped: 0, failed: 0, joined: false };

  const before = await ctx.store.conversation(conversationId);
  const since = before?.syncedTo ?? 0;
  const envelopes = await ctx.transport.getAuth<Envelope[]>(
    `/v1/conversations/${conversationId}/sync?since_id=${since}`,
  );
  if (envelopes.length === 0) return outcome;

  // A row has to exist before anything is applied, because everything that
  // records progress — the cursor, the last message, the epoch — is a field on
  // it, and every one of those writers returns quietly when it is missing.
  //
  // Syncing a conversation that was never stored locally is not a corner case:
  // being added happens on the server, so an invitee's first sync is always
  // this. Without the row the cursor never moves, the same batch is fetched
  // again on every pass, and the second pass hands MLS a commit it has already
  // applied — which it refuses, correctly, and which surfaces as an unreadable
  // message in a conversation that is working perfectly.
  //
  // `kind` is a guess until `discover` overwrites it with the server's answer.
  if (!before) {
    await ctx.store.putConversation({
      id: conversationId,
      title: null,
      kind: "dm",
      epoch: 0,
      syncedTo: 0,
      lastMessage: null,
      updatedAtMs: clock(ctx),
    });
  }

  // Our own device. The delivery service returns every envelope in the
  // conversation, ours included, and MLS cannot decrypt a message this device
  // sent — the ratchet moved on as it encrypted. Handing our own ciphertext to
  // `decrypt` fails every time, and that failure would be reported as "a
  // message could not be read" for a message the sender is looking at.
  const mine = (await ctx.store.identity())?.deviceId;

  // Decoded once. Hex that will not parse never arrived intact, and that is a
  // genuine failure rather than something to skip.
  const decoded: Array<[Envelope, Uint8Array]> = [];
  for (const envelope of envelopes) {
    try {
      decoded.push([envelope, fromHex(envelope.ciphertext)]);
    } catch {
      outcome.failed += 1;
    }
  }

  // Pass one: joins.
  let joinedAt: number | null = null;
  for (const [envelope, bytes] of decoded) {
    if (ctx.crypto.peek(bytes) !== "welcome") continue;
    try {
      ctx.crypto.joinGroup(ctx.device, bytes, clock(ctx));
    } catch {
      // A Welcome for somebody else, or one this device is already past.
      // Neither is an error; pass two counts it as skipped.
      continue;
    }
    joinedAt = envelope.envelope_id;
    outcome.joined = true;
    await persist(ctx);
  }

  let cursor = since;
  const group: Group | undefined = ctx.crypto.loadGroup(ctx.device, conversationId, clock(ctx));

  // Pass two: everything else.
  for (const [envelope, bytes] of decoded) {
    cursor = Math.max(cursor, envelope.envelope_id);

    // Ours already: `sendPayload` writes to history the moment the server
    // accepts, so there is nothing here to learn and nothing to report.
    if (mine !== undefined && envelope.sender_device_id === mine) continue;

    if (joinedAt !== null && envelope.envelope_id <= joinedAt) {
      outcome.skipped += 1;
      continue;
    }

    const kind = ctx.crypto.peek(bytes);
    if (kind === "welcome") {
      // A Welcome we did not join from: either we are already a member, or it
      // is an invitation this device is not the target of.
      outcome.skipped += 1;
      continue;
    }
    if (kind !== "group_message") {
      // `Peeked` is open-ended, so a variant this build does not know lands
      // here rather than being assumed harmless.
      outcome.failed += 1;
      continue;
    }
    if (!group) {
      // A message for a group this device is not in. Not a failure to read —
      // there is nothing here to read it with.
      outcome.skipped += 1;
      continue;
    }

    let decrypted;
    try {
      decrypted = group.decrypt(ctx.device, bytes);
    } catch {
      // Fail closed and say so. No plaintext fallback, no silent skip: a
      // message nobody can read is something somebody needs to be told about.
      outcome.failed += 1;
      await persist(ctx);
      continue;
    }
    await persist(ctx);

    if (decrypted.kind === "commit") {
      outcome.commits += 1;
      continue;
    }
    if (decrypted.kind === "proposal") {
      // Queued, waiting for the commit that carries it. Nothing to show and
      // nothing lost.
      continue;
    }
    if (decrypted.kind !== "message" || !decrypted.plaintext) {
      outcome.failed += 1;
      continue;
    }

    const drew = await applyIncoming(
      ctx,
      conversationId,
      envelope,
      decrypted.plaintext,
      decrypted.sender,
    );
    if (drew) outcome.messages += 1;
  }

  await moveCursor(ctx, conversationId, cursor, group);
  return outcome;
}

/**
 * Conversations the server lists that this device has never heard of.
 *
 * Being added happens entirely on the server, and [`sync`] iterates the
 * *local* list — so without this an invitation is invisible for ever: the
 * Welcome sits inside a conversation nothing ever asks about.
 */
export async function discover(ctx: Context): Promise<string[]> {
  const listed = await ctx.transport.getAuth<ConversationSummary[]>("/v1/conversations");
  const known = new Map((await ctx.store.conversations())
    .map((conversation) => [conversation.id, conversation.title] as const));
  const forgotten = await ctx.store.forgottenConversations();
  const me = (await ctx.store.account())?.handle;

  const fresh: string[] = [];
  for (const summary of listed) {
    const id = summary.conversation_id;
    const through = forgotten.get(id);
    // A local removal holds until something newer appears. When it does,
    // resume after the removed history rather than replaying it from zero.
    if (through !== undefined && (summary.latest_envelope_id ?? 0) <= through) continue;
    if (through !== undefined) await ctx.store.rememberConversation(id);

    // A registration with no commit and no local MLS group is a leftover,
    // not an invitation. A real invitation has a Welcome envelope waiting.
    if (summary.latest_envelope_id === null &&
        !ctx.crypto.loadGroup(ctx.device, id, clock(ctx))) {
      if (known.has(id)) {
        await ctx.store.forgetConversation(id);
        try { await ctx.transport.deleteAuth(`/v1/conversations/${id}`); } catch {
          // The server refuses deletion once an envelope lands; the next
          // listing will then let this conversation through normally.
        }
      }
      continue;
    }

    // The only moment this device can name the conversation: MLS credentials
    // name devices, and an invitee learns of a conversation only through this
    // list. Without the handle there is nothing to call it but "Unnamed".
    const others = summary.members.filter((member) => member !== me);
    const title = summary.kind === "self" ? SELF_TITLE
      : others.length === 1 ? others[0]
      : others.length > 1 ? others.join(", ") : undefined;
    await remember(ctx, summary, title);
    if (through !== undefined && through > 0) {
      const local = await ctx.store.conversation(id);
      if (local) await ctx.store.putConversation({ ...local, syncedTo: through });
    }
    if (!known.has(id)) fresh.push(id);
  }
  return fresh;
}

/** Discover, then sync everything. What a client does when it starts. */
export async function syncAll(ctx: Context): Promise<SyncOutcome> {
  await discover(ctx);
  const total: SyncOutcome = { messages: 0, commits: 0, skipped: 0, failed: 0, joined: false };
  for (const conversation of await ctx.store.conversations()) {
    const one = await sync(ctx, conversation.id);
    total.messages += one.messages;
    total.commits += one.commits;
    total.skipped += one.skipped;
    total.failed += one.failed;
    total.joined ||= one.joined;
  }
  return total;
}

// ------------------------------------------------------------------ applying

/**
 * Writes one decrypted payload into local state.
 *
 * Returns whether it drew a bubble. Several payloads change shared state and
 * leave no message behind — a rename, a reaction, an edit — and counting those
 * as messages would put "1 new message" against a conversation whose only
 * change was somebody's thumbs-up.
 *
 * **Written down now or never.** MLS will not decrypt this envelope a second
 * time, so anything dropped here is gone for good. That is why an unsupported
 * payload keeps its raw bytes: a later build that learns the variant reads
 * them from the store, or never sees them at all.
 */
async function applyIncoming(
  ctx: Context,
  conversationId: string,
  envelope: Envelope,
  plaintext: Uint8Array,
  sender: string | undefined,
): Promise<boolean> {
  const payload = decodePayload(plaintext);
  const from = sender ?? envelope.sender_device_id;
  const at = envelope.server_timestamp_ms;

  switch (payload.kind) {
    case "rename":
      await setTitle(ctx, conversationId, payload.title);
      return false;

    case "reaction": {
      // Checked here because nothing else can: the server never read this
      // payload, so the receiver is the only place the rule can apply. An
      // unacceptable emoji is dropped rather than stored — it would be
      // rendered as-is in a pill.
      if (!isReactionEmoji(payload.emoji)) return false;
      await ctx.store.setReaction(
        {
          id: Store.reactionId(conversationId, payload.target, from),
          conversationId,
          target: payload.target,
          deviceId: from,
          emoji: payload.emoji,
          atMs: at,
        },
        payload.on,
      );
      return false;
    }

    case "story":
      // The key must disappear at expiry, including when an old envelope is
      // synced for the first time after that deadline. No chat bubble is made.
      if (payload.expires_at_ms > at && payload.expires_at_ms > clock(ctx)) {
        await ctx.store.putStory({
          id: payload.story_id && payload.story_id > 0
            ? payload.story_id : legacyStoryId(payload.s3_key),
          authorHandle: "",
          authorDeviceId: envelope.sender_device_id,
          s3Key: payload.s3_key,
          encKey: payload.key,
          nonce: payload.nonce,
          sha256: payload.sha256,
          mime: payload.mime,
          size: payload.size,
          createdAtMs: at,
          expiresAtMs: payload.expires_at_ms,
        });
      }
      return false;

    case "retract":
    case "edit":
      await applyRevision(ctx, conversationId, payload, from, at);
      return false;

    case "group_avatar":
      // The payload is kept, not the picture: it holds the key, and the bytes
      // are fetched when something actually needs to draw them.
      await setAvatar(ctx, conversationId, JSON.stringify(payload));
      return false;

    default: {
      const message: StoredMessage = {
        id: envelope.envelope_id,
        conversationId,
        senderDeviceId: from,
        body: preview(payload),
        sentAtMs: at,
      };
      const name = payloadId(payload);
      if (name !== undefined) message.clientId = name;
      if (payload.kind === "reply") message.replyTo = payload.target;
      // Text needs nothing beyond the body already in `body`. Everything else
      // does — an attachment's key, a sticker's identity, or a variant this
      // build cannot represent and must not re-encode into `{}`.
      if (payload.kind === "unsupported") {
        message.payload = new TextDecoder().decode(plaintext);
      } else if (payload.kind !== "text") {
        message.payload = JSON.stringify(payload);
      }
      await ctx.store.appendMessage(message, envelope.envelope_id);
      return true;
    }
  }
}

/** The same, for a payload this device has just sent and the server took. */
async function applyOwn(
  ctx: Context,
  conversationId: string,
  payload: Payload,
  envelopeId: number,
  clientMsgId: string,
  at: number,
): Promise<void> {
  switch (payload.kind) {
    case "rename":
      await setTitle(ctx, conversationId, payload.title);
      return;

    case "reaction":
      // `self` rather than this device's id: the thread has to know which
      // reactions are ours to draw them as pressed, and MLS never names us as
      // the sender of our own message, so there is no id to match against.
      await ctx.store.setReaction(
        {
          id: Store.reactionId(conversationId, payload.target, "self"),
          conversationId,
          target: payload.target,
          deviceId: "self",
          emoji: payload.emoji,
          atMs: at,
        },
        payload.on,
      );
      return;

    case "story":
      // `stories.postStory` saved the author's copy before the fan-out. A
      // second row in message history would draw an empty, misleading bubble.
      return;

    case "retract":
      await ctx.store.reviseMessage(conversationId, payload.target, {
        body: "",
        retractedAtMs: at,
      });
      return;

    case "edit":
      await ctx.store.reviseMessage(conversationId, payload.target, {
        body: payload.body,
        editedAtMs: payload.edited_at_ms,
      });
      return;

    case "group_avatar":
      await setAvatar(ctx, conversationId, JSON.stringify(payload));
      return;

    default: {
      const message: StoredMessage = {
        id: envelopeId,
        conversationId,
        // `null`, not our device id: MLS names the sender and we are it. The
        // thread uses exactly this to decide which side a bubble sits on.
        senderDeviceId: null,
        body: preview(payload),
        sentAtMs: at,
        clientId: clientMsgId,
      };
      if (payload.kind === "reply") message.replyTo = payload.target;
      if (payload.kind !== "text") message.payload = JSON.stringify(payload);
      await ctx.store.appendMessage(message, envelopeId);
    }
  }
}

/**
 * Applies somebody's edit or retraction to one of their own messages.
 *
 * Three checks, and each is something a modified client would otherwise get
 * away with: the target has to exist, it has to belong to the device asking to
 * change it, and the change has to fall inside the window. None of them can be
 * enforced anywhere else — the server never saw this payload.
 */
async function applyRevision(
  ctx: Context,
  conversationId: string,
  payload:
    | { kind: "edit"; target: string; body: string; edited_at_ms: number }
    | { kind: "retract"; target: string },
  from: string,
  changeSentAtMs: number,
): Promise<void> {
  const target = await ctx.store.messageByClientId(conversationId, payload.target);
  // A message this device never received. Nothing to change, and unlike a
  // reaction, an edit to an unknown message has nothing worth holding on to.
  if (!target) return;
  // `null` means the message is ours, and nobody else may change it. An
  // arriving change can never be ours — our own envelopes are skipped earlier.
  if (target.senderDeviceId === null || target.senderDeviceId !== from) return;
  if (!receiverMayApply(target.sentAtMs, changeSentAtMs)) return;

  if (payload.kind === "retract") {
    await ctx.store.reviseMessage(conversationId, payload.target, {
      body: "",
      retractedAtMs: changeSentAtMs,
    });
    return;
  }
  await ctx.store.reviseMessage(conversationId, payload.target, {
    body: payload.body,
    editedAtMs: payload.edited_at_ms,
  });
}

/** Ten minutes, the same as `EDIT_WINDOW_MS` in `crates/protocol`. */
export const EDIT_WINDOW_MS = 10 * 60 * 1000;
/** What the receiver allows on top, for clock skew between two machines. */
export const RECEIVER_GRACE_MS = 60 * 1000;

/**
 * Whether this device may still change its own message.
 *
 * The courtesy check. A modified client ignores it, which is why the receiver
 * checks too — and why the UI removes the menu entry rather than greying it
 * out: an action that is gone was never offered, and one that is greyed out
 * invites the question of how to get it back.
 */
export function senderMayChange(sentAtMs: number, nowMs: number): boolean {
  const age = nowMs - sentAtMs;
  return age >= 0 && age <= EDIT_WINDOW_MS;
}

/**
 * Whether a receiver applies a change that arrived.
 *
 * The grace is what a sender's fast clock costs: they send at what they think
 * is 9:59, the server stamps 10:01, and without it the sender would apply the
 * change while every receiver refused it — leaving the group permanently
 * disagreeing about what a message says.
 */
export function receiverMayApply(targetSentAtMs: number, changeSentAtMs: number): boolean {
  const age = changeSentAtMs - targetSentAtMs;
  return age >= 0 && age <= EDIT_WINDOW_MS + RECEIVER_GRACE_MS;
}

// ------------------------------------------------------------------ internals

function requireGroup(ctx: Context, conversationId: string): Group {
  const group = ctx.crypto.loadGroup(ctx.device, conversationId, clock(ctx));
  if (!group) throw new TransportError("rejected", "You are not in that conversation.");
  return group;
}

/** Stable local stand-in for a pre-story-id payload. It cannot be downloaded. */
function legacyStoryId(s3Key: string): number {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(s3Key)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  // IndexedDB numeric keys are JavaScript numbers: stay within the safe range.
  return Number((hash & 0x1fffffffffffffn) || 1n);
}

/**
 * Writes down a conversation the server told us about.
 *
 * The cursor is **never** taken from the server's `latest_envelope_id`: that
 * is the server's view of what exists, not a statement about what this device
 * has applied, and adopting it would skip every message already waiting.
 */
async function remember(
  ctx: Context,
  summary: ConversationSummary,
  title?: string,
): Promise<void> {
  const existing = await ctx.store.conversation(summary.conversation_id);
  const conversation: StoredConversation = {
    id: summary.conversation_id,
    title: existing?.title ?? title ?? null,
    kind: summary.kind,
    epoch: summary.epoch,
    syncedTo: existing?.syncedTo ?? 0,
    lastMessage: existing?.lastMessage ?? null,
    members: summary.members,
    // Not zero for one we have never seen: the list sorts by this, and a fresh
    // invitation sorted to the bottom is an invitation nobody finds.
    updatedAtMs: existing?.updatedAtMs ?? clock(ctx),
  };
  await ctx.store.putConversation(conversation);
}

async function moveCursor(
  ctx: Context,
  conversationId: string,
  cursor: number,
  group: Group | undefined,
): Promise<void> {
  const existing = await ctx.store.conversation(conversationId);
  if (!existing) return;
  await ctx.store.putConversation({
    ...existing,
    epoch: group ? Number(group.epoch) : existing.epoch,
    // Never backwards. `appendMessage` has already moved it for anything it
    // stored, and this covers the envelopes that stored nothing — without it,
    // a batch of nothing but reactions would be fetched again for ever.
    syncedTo: Math.max(existing.syncedTo, cursor),
  });
}

async function setTitle(ctx: Context, conversationId: string, title: string): Promise<void> {
  const existing = await ctx.store.conversation(conversationId);
  if (!existing) return;
  await ctx.store.putConversation({ ...existing, title });
}

async function setAvatar(ctx: Context, conversationId: string, encoded: string): Promise<void> {
  const existing = await ctx.store.conversation(conversationId);
  if (!existing) return;
  await ctx.store.putConversation({ ...existing, avatar: encoded });
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new TransportError("rejected", "Malformed hex.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    out[i] = byte;
  }
  return out;
}
