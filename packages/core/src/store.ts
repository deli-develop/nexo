import { idb, openDatabase, searchWords, STORES, transact, type StoreName } from "./idb";

/**
 * Everything this device keeps, behind one typed surface.
 *
 * The same job `crates/store` does for the desktop, and deliberately the same
 * *vocabulary*: `account`, `setRefreshToken`, `mlsState`, `wipe`. Wave 7 swaps
 * what is behind `lib/*.ts`, and a rename at this layer would turn that swap
 * into a rewrite for no gain.
 *
 * Two honest differences from the Rust one:
 *
 * - **Every read is a promise.** IndexedDB answers later. That is not a style
 *   choice and it cannot be hidden.
 * - **Nothing here is encrypted at rest.** SQLCipher had a key from the OS
 *   keystore; a browser has no such place. `docs/REWORK.md` records that as
 *   the price of one client across three targets, and the app has to say so
 *   rather than let somebody assume otherwise.
 */

/** The signed-in account, as this device remembers it. */
export interface Account {
  userId: number;
  handle: string;
  displayName: string;
}

/** The long-term identity, and the device it names. */
export interface Identity {
  deviceId: string;
  /** The Ed25519 secret. The one genuinely dangerous thing in the store. */
  secret: Uint8Array;
}

/** One conversation, as the list draws it. */
export interface StoredConversation {
  id: string;
  title: string | null;
  kind: string;
  epoch: number;
  /** Highest envelope id this device has applied. */
  syncedTo: number;
  lastMessage: string | null;
  updatedAtMs: number;
  /**
   * Whether this device sent the most recent message.
   *
   * What decides that a conversation whose newest message is our own never
   * toasts and never counts as unread — which is not derivable from
   * `lastMessage`, a string that looks identical either way.
   */
  lastMessageOutgoing?: boolean;
  /**
   * Everyone in it, by handle.
   *
   * From the server's conversation list, which is the only place handles
   * exist: MLS names *devices*, so a client holding the group has no way to
   * say whose leaf is whose. Absent until a `discover` has run.
   */
  members?: string[];
  /**
   * The encoded `group_avatar` payload, when somebody set one.
   *
   * The payload rather than the picture: it holds the key the bytes are
   * encrypted under, and the bytes are fetched when something needs to draw
   * them.
   */
  avatar?: string;
}

/** One message, already decrypted, as history. */
export interface StoredMessage {
  /** The envelope id, or a negative local id for something not yet sent. */
  id: number;
  conversationId: string;
  /** `null` for this device's own messages: MLS names the sender, we are it. */
  senderDeviceId: string | null;
  body: string;
  sentAtMs: number;
  /** The encoded payload, when the body alone cannot reconstruct the message. */
  payload?: string;
  /**
   * The sender's own name for this message, when they gave one.
   *
   * What an edit or a retract names. Absent on anything sent before names
   * existed, which is why nothing may assume it is there.
   */
  clientId?: string;
  /** The `clientId` this message answers, lifted out of the payload. */
  replyTo?: string;
  /** Set when the sender changed it; the body above is the current one. */
  editedAtMs?: number;
  /** Set when the sender took it back. The body is cleared with it. */
  retractedAtMs?: number;
}

/** One reaction. Shared state rather than a message: it draws no bubble. */
export interface StoredReaction {
  /** `conversationId|target|deviceId`, so reacting twice replaces. */
  id: string;
  conversationId: string;
  /** The `clientId` of the message reacted to. */
  target: string;
  /** Who reacted. MLS authenticated them, so this is not a claim. */
  deviceId: string;
  emoji: string;
  atMs: number;
}

/** One queued send, waiting for a network. */
export interface OutboxEntry {
  id?: number;
  conversationId: string;
  /** Hex ciphertext, already encrypted — the queue holds no plaintext. */
  ciphertext: string;
  epoch: number;
  isCommit: boolean;
  clientMsgId: string;
  queuedAtMs: number;
}

/** A story and its decryption key, retained only until it expires. */
export interface StoredStory {
  id: number;
  authorHandle: string;
  authorDeviceId: string;
  s3Key: string;
  encKey: string;
  nonce: string;
  sha256: string;
  mime: string;
  size: number;
  createdAtMs: number;
  expiresAtMs: number;
}

/** A one-time attachment. Once opened, its three key fields are null. */
export interface StoredViewOnce {
  clientId: string;
  conversationId: string;
  s3Key: string;
  encKey: string | null;
  nonce: string | null;
  sha256: string | null;
  mime: string;
  size: number;
  receivedAtMs: number;
  openedAtMs: number | null;
}

export interface StoredFolder {
  id: number;
  name: string;
  conversations: string[];
}

/** The baseline and verification state of one MLS device in a conversation. */
export interface StoredPeer {
  deviceId: string;
  identityKey: Uint8Array;
  firstSeenMs: number;
  verifiedKey: Uint8Array | null;
  changedAtMs: number | null;
}

export interface SearchHit {
  id: number;
  conversationId: string;
  body: string;
  sentAtMs: number;
  outgoing: boolean;
}

export interface PinRecord {
  salt: Uint8Array;
  hash: Uint8Array;
  attempts: number;
}

interface SearchTerm {
  id: string;
  term: string;
  messageId: number;
}

async function unindexMessage(tx: IDBTransaction, messageId: number): Promise<void> {
  const rows = await idb.getAllByIndex<SearchTerm>(tx, "searchTerms", "byMessage", messageId);
  for (const row of rows) await idb.delete(tx, "searchTerms", row.id);
}

async function indexMessage(tx: IDBTransaction, message: StoredMessage): Promise<void> {
  if (message.id < 0 || message.body.trim() === "") return;
  for (const term of searchWords(message.body)) {
    await idb.put(tx, "searchTerms", {
      id: `${message.id}|${term}`,
      term,
      messageId: message.id,
    } satisfies SearchTerm);
  }
}

/** The single-row stores all use this key; there is only ever one of each. */
const ONE = "one";

export class Store {
  readonly #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  static async open(name = "nexo", factory?: IDBFactory): Promise<Store> {
    return new Store(await openDatabase(name, factory ?? globalThis.indexedDB));
  }

  close(): void {
    this.#db.close();
  }

  // ------------------------------------------------------------------ account

  async account(): Promise<Account | null> {
    return transact(this.#db, "account", "readonly", async (tx) => {
      const row = await idb.get<Account & { id: string }>(tx, "account", ONE);
      if (!row) return null;
      return { userId: row.userId, handle: row.handle, displayName: row.displayName };
    });
  }

  async setAccount(account: Account): Promise<void> {
    await transact(this.#db, "account", "readwrite", (tx) =>
      idb.put(tx, "account", { id: ONE, ...account }),
    );
  }

  /** One commit for the four pieces a usable sign-in must have together. */
  async persistSignIn(
    account: Account,
    identity: Identity,
    refreshToken: string,
    mlsState: Uint8Array,
  ): Promise<void> {
    await transact(this.#db, ["account", "identity", "session", "mlsState"], "readwrite", async (tx) => {
      const previous = await idb.get<Account>(tx, "account", ONE);
      if (previous && previous.handle !== account.handle) {
        throw new Error(`This device still holds ${previous.handle}'s account.`);
      }
      await idb.put(tx, "account", { id: ONE, ...account });
      await idb.put(tx, "identity", { id: ONE, ...identity });
      await idb.put(tx, "session", { id: ONE, token: refreshToken });
      await idb.put(tx, "mlsState", { id: ONE, blob: mlsState });
    });
  }

  // ----------------------------------------------------------------- identity

  async identity(): Promise<Identity | null> {
    return transact(this.#db, "identity", "readonly", async (tx) => {
      const row = await idb.get<Identity & { id: string }>(tx, "identity", ONE);
      return row ? { deviceId: row.deviceId, secret: row.secret } : null;
    });
  }

  async setIdentity(identity: Identity): Promise<void> {
    await transact(this.#db, "identity", "readwrite", (tx) =>
      idb.put(tx, "identity", { id: ONE, ...identity }),
    );
  }

  // ------------------------------------------------------------------ session

  /**
   * The refresh token, which rotates on every use.
   *
   * Written by the transport's rotation callback and read once at start. The
   * whole reason it is persisted at all: replaying a spent one is what the
   * server reads as theft, and it answers by revoking every session for the
   * account.
   */
  async refreshToken(): Promise<string | null> {
    return transact(this.#db, "session", "readonly", async (tx) => {
      const row = await idb.get<{ id: string; token: string }>(tx, "session", ONE);
      return row?.token ?? null;
    });
  }

  async setRefreshToken(token: string): Promise<void> {
    await transact(this.#db, "session", "readwrite", (tx) =>
      idb.put(tx, "session", { id: ONE, token }),
    );
  }

  async clearRefreshToken(): Promise<void> {
    await transact(this.#db, "session", "readwrite", (tx) => idb.delete(tx, "session", ONE));
  }

  // ---------------------------------------------------------------- MLS state

  /** The whole MLS provider as one blob, exactly as `crypto-wasm` encodes it. */
  async mlsState(): Promise<Uint8Array | null> {
    return transact(this.#db, "mlsState", "readonly", async (tx) => {
      const row = await idb.get<{ id: string; blob: Uint8Array }>(tx, "mlsState", ONE);
      return row?.blob ?? null;
    });
  }

  async setMlsState(blob: Uint8Array): Promise<void> {
    await transact(this.#db, "mlsState", "readwrite", (tx) =>
      idb.put(tx, "mlsState", { id: ONE, blob }),
    );
  }

  // ------------------------------------------------------------ conversations

  async conversations(): Promise<StoredConversation[]> {
    const rows = await transact(this.#db, "conversations", "readonly", (tx) =>
      idb.getAll<StoredConversation>(tx, "conversations"),
    );
    // Most recently active first, which is the only order a list ever wants.
    return rows.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  async conversation(id: string): Promise<StoredConversation | null> {
    return transact(this.#db, "conversations", "readonly", async (tx) =>
      (await idb.get<StoredConversation>(tx, "conversations", id)) ?? null,
    );
  }

  async putConversation(conversation: StoredConversation): Promise<void> {
    await transact(this.#db, "conversations", "readwrite", (tx) =>
      idb.put(tx, "conversations", conversation),
    );
  }

  // ----------------------------------------------------------------- messages

  async messages(conversationId: string): Promise<StoredMessage[]> {
    const rows = await transact(this.#db, "messages", "readonly", (tx) =>
      idb.getAllByIndex<StoredMessage>(tx, "messages", "byConversation", conversationId),
    );
    return rows.sort((a, b) => a.sentAtMs - b.sentAtMs || a.id - b.id);
  }

  /**
   * Writes a message and moves the conversation's cursor in **one**
   * transaction.
   *
   * Two transactions would let a crash land the message without the cursor —
   * so the next sync fetches it again and the history shows it twice — or the
   * cursor without the message, which loses it for good. Neither is
   * recoverable from the client, so they commit together or not at all.
   */
  async appendMessage(message: StoredMessage, syncedTo?: number): Promise<void> {
    await transact(this.#db, ["messages", "conversations", "searchTerms"], "readwrite", (tx) =>
      writeMessage(tx, message, syncedTo),
    );
  }

  /**
   * An arriving view-once: the bubble's row and the key's row, together.
   *
   * One transaction, because MLS will not decrypt the envelope twice — a key
   * written without its bubble, or a bubble without its key, could never be
   * put right. The message row must already be key-free (`viewOnceBubble`).
   */
  async appendViewOnce(message: StoredMessage, item: StoredViewOnce, syncedTo: number): Promise<void> {
    await transact(
      this.#db,
      ["messages", "conversations", "searchTerms", "viewOnce"],
      "readwrite",
      async (tx) => {
        if (!(await idb.get<StoredViewOnce>(tx, "viewOnce", item.clientId))) {
          await idb.put(tx, "viewOnce", item);
        }
        await writeMessage(tx, message, syncedTo);
      },
    );
  }

  /**
   * One message by its envelope id, wherever it is.
   *
   * No conversation needed: an envelope id is the server's, and it is unique
   * across every conversation this device is in — which is why `messages` is
   * keyed by it. A caller that has an id and not a conversation is the normal
   * case, not a shortcut.
   */
  async message(id: number): Promise<StoredMessage | null> {
    return transact(this.#db, "messages", "readonly", async (tx) =>
      (await idb.get<StoredMessage>(tx, "messages", id)) ?? null,
    );
  }

  /** One message by the name its sender gave it, or nothing. */
  async messageByClientId(
    conversationId: string,
    clientId: string,
  ): Promise<StoredMessage | null> {
    const rows = await transact(this.#db, "messages", "readonly", (tx) =>
      idb.getAllByIndex<StoredMessage>(tx, "messages", "byClient", [conversationId, clientId]),
    );
    return rows[0] ?? null;
  }

  /**
   * Applies an edit or a retraction to a message already in history.
   *
   * Whether the change is *allowed* is decided in `conversations.ts`, where
   * the sender of the change and the sender of the target can be compared.
   * This writes it down; it does not adjudicate.
   *
   * The conversation's preview moves with the message when the message is the
   * last one, because a row still showing the retracted text is the one place
   * a retraction most obviously has to work.
   */
  async reviseMessage(
    conversationId: string,
    clientId: string,
    change: { body: string; editedAtMs?: number; retractedAtMs?: number },
  ): Promise<boolean> {
    return transact(this.#db, ["messages", "conversations", "searchTerms"], "readwrite", async (tx) => {
      const rows = await idb.getAllByIndex<StoredMessage>(tx, "messages", "byClient", [
        conversationId,
        clientId,
      ]);
      const message = rows[0];
      if (!message) return false;

      const revised: StoredMessage = { ...message, body: change.body };
      if (change.editedAtMs !== undefined) revised.editedAtMs = change.editedAtMs;
      if (change.retractedAtMs !== undefined) {
        revised.retractedAtMs = change.retractedAtMs;
        // The payload can hold the text too — an attachment's caption, a
        // reply's body. Taking back the message and leaving that behind would
        // be taking back nothing.
        delete revised.payload;
      }
      await unindexMessage(tx, message.id);
      await idb.put(tx, "messages", revised);
      await indexMessage(tx, revised);

      const conversation = await idb.get<StoredConversation>(
        tx,
        "conversations",
        conversationId,
      );
      if (conversation && conversation.lastMessage === message.body) {
        await idb.put(tx, "conversations", { ...conversation, lastMessage: change.body });
      }
      return true;
    });
  }

  /** Local-only removal, including its search terms, pin, and queued send. */
  async deleteMessage(conversationId: string, envelopeId: number): Promise<void> {
    await transact(
      this.#db,
      ["messages", "searchTerms", "pinnedMessages", "outbox", "conversations"],
      "readwrite",
      async (tx) => {
        const message = await idb.get<StoredMessage>(tx, "messages", envelopeId);
        if (message?.conversationId !== conversationId) return;
        await unindexMessage(tx, envelopeId);
        await idb.delete(tx, "messages", envelopeId);
        await idb.delete(tx, "pinnedMessages", `${conversationId}|${envelopeId}`);
        if (message.clientId) {
          const queued = await idb.getAll<Required<OutboxEntry>>(tx, "outbox");
          for (const entry of queued) {
            if (entry.conversationId === conversationId && entry.clientMsgId === message.clientId) {
              await idb.delete(tx, "outbox", entry.id);
            }
          }
        }

        const conversation = await idb.get<StoredConversation>(tx, "conversations", conversationId);
        if (conversation?.lastMessage === message.body) {
          const remaining = await idb.getAllByIndex<StoredMessage>(
            tx, "messages", "byConversation", conversationId,
          );
          const latest = remaining.sort((a, b) => b.sentAtMs - a.sentAtMs || b.id - a.id)[0];
          await idb.put(tx, "conversations", {
            ...conversation,
            lastMessage: latest?.body ?? null,
            updatedAtMs: latest?.sentAtMs ?? conversation.updatedAtMs,
          });
        }
      },
    );
  }

  // ---------------------------------------------------------------- reactions

  async reactions(conversationId: string): Promise<StoredReaction[]> {
    return transact(this.#db, "reactions", "readonly", (tx) =>
      idb.getAllByIndex<StoredReaction>(tx, "reactions", "byConversation", conversationId),
    );
  }

  /**
   * Turns one person's reaction on or off.
   *
   * Kept even when the message it names is not here: there is no foreign key,
   * and a reaction that arrived before its message lights up when the message
   * turns up rather than being lost for the timing.
   */
  async setReaction(reaction: StoredReaction, on: boolean): Promise<void> {
    await transact(this.#db, "reactions", "readwrite", (tx) =>
      on ? idb.put(tx, "reactions", reaction) : idb.delete(tx, "reactions", reaction.id),
    );
  }

  /** The key one person's reaction to one message lives under. */
  static reactionId(conversationId: string, target: string, deviceId: string): string {
    return `${conversationId}|${target}|${deviceId}`;
  }

  // ------------------------------------------------------------------- outbox

  /** Queued sends, oldest first — which is the order they must leave in. */
  async outbox(): Promise<Required<OutboxEntry>[]> {
    const rows = await transact(this.#db, "outbox", "readonly", (tx) =>
      idb.getAll<Required<OutboxEntry>>(tx, "outbox"),
    );
    return rows.sort((a, b) => a.id - b.id);
  }

  async enqueue(entry: OutboxEntry): Promise<number> {
    const key = await transact(this.#db, "outbox", "readwrite", (tx) =>
      idb.put(tx, "outbox", entry),
    );
    return key as number;
  }

  async dequeue(id: number): Promise<void> {
    await transact(this.#db, "outbox", "readwrite", (tx) => idb.delete(tx, "outbox", id));
  }

  // ------------------------------------------------------------------- drafts

  async draft(conversationId: string): Promise<string | null> {
    return transact(this.#db, "drafts", "readonly", async (tx) => {
      const row = await idb.get<{ conversationId: string; body: string }>(
        tx,
        "drafts",
        conversationId,
      );
      return row?.body ?? null;
    });
  }

  /**
   * An emptied draft is deleted rather than stored blank, so abandoning one
   * leaves nothing behind — the same rule `crates/store` states for itself.
   */
  async setDraft(conversationId: string, body: string): Promise<void> {
    await transact(this.#db, "drafts", "readwrite", (tx) =>
      body.trim() === ""
        ? idb.delete(tx, "drafts", conversationId)
        : idb.put(tx, "drafts", { conversationId, body }),
    );
  }

  async conversationsWithDrafts(): Promise<string[]> {
    const rows = await transact(this.#db, "drafts", "readonly", (tx) =>
      idb.getAll<{ conversationId: string }>(tx, "drafts"),
    );
    return rows.map((row) => row.conversationId);
  }

  // ------------------------------------------------------------------ stories

  /** The first copy wins when one story arrives over several conversations. */
  async putStory(story: StoredStory): Promise<void> {
    await transact(this.#db, "stories", "readwrite", async (tx) => {
      if (!(await idb.get<StoredStory>(tx, "stories", story.id))) {
        await idb.put(tx, "stories", story);
      }
    });
  }

  /** Purges expired decryption keys before returning anything to the caller. */
  async liveStories(nowMs: number): Promise<StoredStory[]> {
    const live = await transact(this.#db, "stories", "readwrite", async (tx) => {
      const rows = await idb.getAll<StoredStory>(tx, "stories");
      for (const story of rows) {
        if (story.expiresAtMs <= nowMs) await idb.delete(tx, "stories", story.id);
      }
      return rows.filter((story) => story.expiresAtMs > nowMs);
    });
    return live.sort((a, b) => b.createdAtMs - a.createdAtMs || b.id - a.id);
  }

  // --------------------------------------------------------------- view once

  /** Replaying a message must never restore a key already destroyed. */
  async putViewOnce(item: StoredViewOnce): Promise<void> {
    await transact(this.#db, "viewOnce", "readwrite", async (tx) => {
      if (!(await idb.get<StoredViewOnce>(tx, "viewOnce", item.clientId))) {
        await idb.put(tx, "viewOnce", item);
      }
    });
  }

  async viewOnce(clientId: string): Promise<StoredViewOnce | null> {
    return transact(this.#db, "viewOnce", "readonly", async (tx) =>
      (await idb.get<StoredViewOnce>(tx, "viewOnce", clientId)) ?? null,
    );
  }

  async viewOnceIn(conversationId: string): Promise<StoredViewOnce[]> {
    return transact(this.#db, "viewOnce", "readonly", (tx) =>
      idb.getAllByIndex<StoredViewOnce>(tx, "viewOnce", "byConversation", conversationId),
    );
  }

  /** Call only after plaintext was produced successfully. The row survives. */
  async burnViewOnce(clientId: string, nowMs: number): Promise<void> {
    await transact(this.#db, "viewOnce", "readwrite", async (tx) => {
      const row = await idb.get<StoredViewOnce>(tx, "viewOnce", clientId);
      if (row?.encKey === null || !row) return;
      await idb.put(tx, "viewOnce", {
        ...row, encKey: null, nonce: null, sha256: null, openedAtMs: nowMs,
      } satisfies StoredViewOnce);
    });
  }

  // ------------------------------------------------------------------ folders

  /** New folders appear at the end of the rail. */
  async createFolder(name: string, nowMs: number): Promise<number> {
    const key = await transact(this.#db, "folders", "readwrite", async (tx) => {
      const rows = await idb.getAll<{ position: number }>(tx, "folders");
      const position = Math.max(-1, ...rows.map((row) => row.position)) + 1;
      return idb.put(tx, "folders", { name, position, createdAtMs: nowMs });
    });
    return Number(key);
  }

  async renameFolder(id: number, name: string): Promise<void> {
    await transact(this.#db, "folders", "readwrite", async (tx) => {
      const row = await idb.get<{ id: number; position: number; createdAtMs: number }>(
        tx, "folders", id,
      );
      if (row) await idb.put(tx, "folders", { ...row, name });
    });
  }

  async deleteFolder(id: number): Promise<void> {
    await transact(this.#db, ["folders", "folderMembers"], "readwrite", async (tx) => {
      const members = await idb.getAllByIndex<{ id: string }>(
        tx, "folderMembers", "byFolder", id,
      );
      for (const member of members) await idb.delete(tx, "folderMembers", member.id);
      await idb.delete(tx, "folders", id);
    });
  }

  async setFolderMember(folderId: number, conversationId: string, member: boolean): Promise<void> {
    await transact(this.#db, ["folders", "folderMembers"], "readwrite", async (tx) => {
      const id = `${folderId}|${conversationId}`;
      if (!member) {
        await idb.delete(tx, "folderMembers", id);
        return;
      }
      if (!(await idb.get(tx, "folders", folderId))) {
        throw new Error(`Folder ${folderId} does not exist.`);
      }
      if (!(await idb.get(tx, "folderMembers", id))) {
        await idb.put(tx, "folderMembers", { id, folderId, conversationId });
      }
    });
  }

  async folders(): Promise<StoredFolder[]> {
    return transact(this.#db, ["folders", "folderMembers"], "readonly", async (tx) => {
      const folders = await idb.getAll<{
        id: number; name: string; position: number;
      }>(tx, "folders");
      const members = await idb.getAll<{ folderId: number; conversationId: string }>(
        tx, "folderMembers",
      );
      return folders
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map(({ id, name }) => ({
          id, name,
          conversations: members.filter((member) => member.folderId === id)
            .map((member) => member.conversationId),
        }));
    });
  }

  // --------------------------------------------------------------------- pins

  /** Local message pins are never sent to the server. */
  async setPinned(conversationId: string, envelopeId: number, pinned: boolean, nowMs: number): Promise<void> {
    await transact(this.#db, "pinnedMessages", "readwrite", async (tx) => {
      const id = `${conversationId}|${envelopeId}`;
      if (!pinned) {
        await idb.delete(tx, "pinnedMessages", id);
      } else if (!(await idb.get(tx, "pinnedMessages", id))) {
        await idb.put(tx, "pinnedMessages", { id, conversationId, envelopeId, pinnedAtMs: nowMs });
      }
    });
  }

  async pinnedMessages(conversationId: string): Promise<Array<StoredMessage & { pinned: true }>> {
    return transact(this.#db, ["pinnedMessages", "messages"], "readonly", async (tx) => {
      const pins = await idb.getAllByIndex<{
        envelopeId: number; pinnedAtMs: number;
      }>(tx, "pinnedMessages", "byConversation", conversationId);
      const result: Array<StoredMessage & { pinned: true; pinnedAtMs: number }> = [];
      for (const pin of pins) {
        const message = await idb.get<StoredMessage>(tx, "messages", pin.envelopeId);
        if (message?.conversationId === conversationId) {
          result.push({ ...message, pinned: true, pinnedAtMs: pin.pinnedAtMs });
        }
      }
      return result.sort((a, b) => b.pinnedAtMs - a.pinnedAtMs || b.id - a.id);
    });
  }

  // ------------------------------------------------------------------- search

  /** Literal word search; the last word is a prefix, like the Rust FTS query. */
  async searchMessages(term: string, conversationId: string | null = null, limit = 50): Promise<SearchHit[]> {
    const tokens = term.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length === 0 || limit <= 0) return [];
    return transact(this.#db, ["searchTerms", "messages"], "readonly", async (tx) => {
      const rows = await idb.getAll<SearchTerm>(tx, "searchTerms");
      const last = tokens[tokens.length - 1]!;
      const matching = new Map<number, Set<string>>();
      for (const row of rows) {
        if (!tokens.slice(0, -1).includes(row.term) && !row.term.startsWith(last)) continue;
        const terms = matching.get(row.messageId) ?? new Set<string>();
        terms.add(row.term);
        matching.set(row.messageId, terms);
      }
      const hits: SearchHit[] = [];
      for (const [id, terms] of matching) {
        if (!tokens.slice(0, -1).every((token) => terms.has(token))) continue;
        if (![...terms].some((value) => value.startsWith(last))) continue;
        const message = await idb.get<StoredMessage>(tx, "messages", id);
        if (!message || (conversationId !== null && message.conversationId !== conversationId)) continue;
        hits.push({
          id: message.id,
          conversationId: message.conversationId,
          body: message.body,
          sentAtMs: message.sentAtMs,
          outgoing: message.senderDeviceId === null,
        });
      }
      return hits.sort((a, b) => b.sentAtMs - a.sentAtMs || b.id - a.id).slice(0, limit);
    });
  }

  // ---------------------------------------------------- forgotten conversations

  async conversationIds(): Promise<string[]> {
    return (await this.conversations()).map((conversation) => conversation.id);
  }

  /**
   * Removes one local conversation and remembers its cursor. It returns only
   * when every dependent local row and the tombstone committed together.
   */
  async forgetConversation(conversationId: string): Promise<void> {
    const names: StoreName[] = [
      "conversations", "messages", "searchTerms", "outbox", "reactions",
      "pinnedMessages", "viewOnce", "drafts", "folderMembers",
      "conversationPeers", "forgottenConversations",
    ];
    await transact(this.#db, names, "readwrite", async (tx) => {
      const conversation = await idb.get<StoredConversation>(tx, "conversations", conversationId);
      const prior = await idb.get<{ id: string; throughEnvelopeId: number }>(
        tx, "forgottenConversations", conversationId,
      );
      const throughEnvelopeId = Math.max(conversation?.syncedTo ?? 0, prior?.throughEnvelopeId ?? 0);

      const messages = await idb.getAllByIndex<StoredMessage>(
        tx, "messages", "byConversation", conversationId,
      );
      for (const message of messages) {
        await unindexMessage(tx, message.id);
        await idb.delete(tx, "messages", message.id);
      }

      const outbox = await idb.getAll<Required<OutboxEntry>>(tx, "outbox");
      for (const entry of outbox) {
        if (entry.conversationId === conversationId) await idb.delete(tx, "outbox", entry.id);
      }

      for (const name of ["reactions", "pinnedMessages", "viewOnce", "folderMembers", "conversationPeers"] as const) {
        const rows = await idb.getAllByIndex<{ id?: string; clientId?: string }>(
          tx, name, "byConversation", conversationId,
        );
        for (const row of rows) {
          await idb.delete(tx, name, row.id ?? row.clientId!);
        }
      }
      await idb.delete(tx, "drafts", conversationId);
      await idb.delete(tx, "conversations", conversationId);
      await idb.put(tx, "forgottenConversations", { id: conversationId, throughEnvelopeId });
    });
  }

  /** The last envelope present when each conversation was removed. */
  async forgottenConversations(): Promise<Map<string, number>> {
    const rows = await transact(this.#db, "forgottenConversations", "readonly", (tx) =>
      idb.getAll<{ id: string; throughEnvelopeId: number }>(tx, "forgottenConversations"),
    );
    return new Map(rows.map((row) => [row.id, row.throughEnvelopeId]));
  }

  async rememberConversation(conversationId: string): Promise<void> {
    await transact(this.#db, "forgottenConversations", "readwrite", (tx) =>
      idb.delete(tx, "forgottenConversations", conversationId),
    );
  }

  // ---------------------------------------------------------- peer identities

  async peers(conversationId: string): Promise<StoredPeer[]> {
    const rows = await transact(this.#db, "conversationPeers", "readonly", (tx) =>
      idb.getAllByIndex<StoredPeer>(tx, "conversationPeers", "byConversation", conversationId),
    );
    return rows.map((row) => ({
      deviceId: row.deviceId,
      identityKey: row.identityKey,
      firstSeenMs: row.firstSeenMs,
      verifiedKey: row.verifiedKey,
      changedAtMs: row.changedAtMs,
    }));
  }

  /** New devices establish a baseline; a changed key invalidates verification. */
  async recordPeers(
    conversationId: string,
    peers: Array<{ deviceId: string; identityKey: Uint8Array }>,
    nowMs: number,
  ): Promise<string[]> {
    return transact(this.#db, "conversationPeers", "readwrite", async (tx) => {
      const changed: string[] = [];
      for (const peer of peers) {
        const id = `${conversationId}|${peer.deviceId}`;
        const previous = await idb.get<StoredPeer>(tx, "conversationPeers", id);
        if (!previous) {
          await idb.put(tx, "conversationPeers", {
            id, conversationId, ...peer, firstSeenMs: nowMs,
            verifiedKey: null, changedAtMs: null,
          });
        } else if (!sameBytes(previous.identityKey, peer.identityKey)) {
          await idb.put(tx, "conversationPeers", {
            ...previous, id, conversationId, identityKey: peer.identityKey,
            verifiedKey: null, changedAtMs: nowMs,
          });
          changed.push(peer.deviceId);
        }
      }
      return changed;
    });
  }

  async markVerified(conversationId: string): Promise<void> {
    await transact(this.#db, "conversationPeers", "readwrite", async (tx) => {
      const rows = await idb.getAllByIndex<StoredPeer & { id: string }>(
        tx, "conversationPeers", "byConversation", conversationId,
      );
      for (const row of rows) {
        await idb.put(tx, "conversationPeers", {
          ...row, verifiedKey: row.identityKey, changedAtMs: null,
        });
      }
    });
  }

  /** Dismisses a warning without claiming that a new key was verified. */
  async acknowledgeKeyChange(conversationId: string): Promise<void> {
    await transact(this.#db, "conversationPeers", "readwrite", async (tx) => {
      const rows = await idb.getAllByIndex<StoredPeer & { id: string }>(
        tx, "conversationPeers", "byConversation", conversationId,
      );
      for (const row of rows) await idb.put(tx, "conversationPeers", { ...row, changedAtMs: null });
    });
  }

  // ---------------------------------------------------------------- local PIN

  async loadPin(): Promise<PinRecord | null> {
    const row = await transact(this.#db, "pin", "readonly", (tx) =>
      idb.get<PinRecord>(tx, "pin", ONE),
    );
    return row ? { salt: row.salt, hash: row.hash, attempts: row.attempts } : null;
  }

  async putPin(record: PinRecord): Promise<void> {
    await transact(this.#db, "pin", "readwrite", (tx) =>
      idb.put(tx, "pin", { id: ONE, ...record }),
    );
  }

  async clearPin(): Promise<void> {
    await transact(this.#db, "pin", "readwrite", (tx) => idb.delete(tx, "pin", ONE));
  }

  /** A concurrent PIN check cannot spend the same allowed attempt twice. */
  async setPinAttempts(expected: number, next: number): Promise<boolean> {
    return transact(this.#db, "pin", "readwrite", async (tx) => {
      const row = await idb.get<PinRecord & { id: string }>(tx, "pin", ONE);
      if (!row || row.attempts !== expected) return false;
      await idb.put(tx, "pin", { ...row, attempts: next });
      return true;
    });
  }

  // --------------------------------------------------------------------- wipe

  /**
   * Everything, gone. Signing out, and the failure path of a sign-in.
   *
   * One transaction across every store: a half-wiped device that still holds
   * an identity but no account is a state nothing knows how to resume from.
   */
  async wipe(): Promise<void> {
    const names = Object.keys(STORES) as StoreName[];
    await transact(this.#db, names, "readwrite", async (tx) => {
      for (const name of names) await idb.clear(tx, name);
    });
  }
}

/** One message into history, and the conversation's summary moved with it. */
async function writeMessage(tx: IDBTransaction, message: StoredMessage, syncedTo?: number): Promise<void> {
  await unindexMessage(tx, message.id);
  await idb.put(tx, "messages", message);
  await indexMessage(tx, message);
  const conversation = await idb.get<StoredConversation>(tx, "conversations", message.conversationId);
  if (!conversation) return;
  await idb.put(tx, "conversations", {
    ...conversation,
    lastMessage: message.body,
    lastMessageOutgoing: message.senderDeviceId === null,
    updatedAtMs: Math.max(conversation.updatedAtMs, message.sentAtMs),
    syncedTo: syncedTo === undefined
      ? conversation.syncedTo
      : Math.max(conversation.syncedTo, syncedTo),
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
