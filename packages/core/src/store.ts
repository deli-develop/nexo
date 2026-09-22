import { idb, openDatabase, transact } from "./idb";

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
    await transact(this.#db, ["messages", "conversations"], "readwrite", async (tx) => {
      await idb.put(tx, "messages", message);
      const conversation = await idb.get<StoredConversation>(
        tx,
        "conversations",
        message.conversationId,
      );
      if (!conversation) return;
      await idb.put(tx, "conversations", {
        ...conversation,
        lastMessage: message.body,
        updatedAtMs: Math.max(conversation.updatedAtMs, message.sentAtMs),
        syncedTo: syncedTo === undefined
          ? conversation.syncedTo
          : Math.max(conversation.syncedTo, syncedTo),
      });
    });
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
    return transact(this.#db, ["messages", "conversations"], "readwrite", async (tx) => {
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
      await idb.put(tx, "messages", revised);

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

  // --------------------------------------------------------------------- wipe

  /**
   * Everything, gone. Signing out, and the failure path of a sign-in.
   *
   * One transaction across every store: a half-wiped device that still holds
   * an identity but no account is a state nothing knows how to resume from.
   */
  async wipe(): Promise<void> {
    const names = [
      "account",
      "identity",
      "session",
      "mlsState",
      "conversations",
      "messages",
      "reactions",
      "outbox",
      "drafts",
    ] as const;
    await transact(this.#db, [...names], "readwrite", async (tx) => {
      for (const name of names) await idb.clear(tx, name);
    });
  }
}
