/**
 * A promise over IndexedDB, and the schema ladder.
 *
 * Written rather than pulled in. Dexie and idb are good libraries, but this
 * needs perhaps eighty lines of the surface they offer, and rule 8 makes every
 * dependency a decision rather than a convenience. What is here is auditable
 * in one sitting; a query builder would not be.
 *
 * # What this is not, and it matters
 *
 * `crates/store` is SQLCipher: one file, encrypted at rest with a key the OS
 * keystore wraps. **This is not that.** IndexedDB is plaintext on disk, the
 * browser owns it, and anybody with the machine can read it. That is the cost
 * of invariant 2 being retired for the web, recorded in `docs/REWORK.md` and
 * not to be discovered by somebody reading this file.
 *
 * The other difference is shape: SQLite answers immediately and IndexedDB
 * answers later, so every read here is a promise where the Rust one is a
 * value. That ripples all the way up, and is why `packages/core` is async
 * throughout while `crates/client` is not.
 */

/**
 * Bumped whenever the stores below change.
 *
 * The ladder is the same discipline `crates/store` uses: a rung is never
 * rewritten once anybody has climbed it, because a database created before the
 * edit took the old path and the two would disagree. Add a rung instead.
 */
export const SCHEMA_VERSION = 2;

/** Every object store, and what makes a row unique in it. */
export const STORES = {
  /** One row. The signed-in account, or nothing. */
  account: { keyPath: "id" },
  /** One row. The identity secret and the device id it names. */
  identity: { keyPath: "id" },
  /** One row. The refresh token, rotated on every use. */
  session: { keyPath: "id" },
  /** One row. The whole MLS provider, as one blob. */
  mlsState: { keyPath: "id" },
  conversations: { keyPath: "id" },
  /**
   * Keyed by envelope id; indexed by conversation for the obvious read, and by
   * the sender's own name for the message so an edit or a retract can find its
   * target. A row without a `clientId` is simply absent from that index —
   * IndexedDB skips records whose key path is undefined — which is exactly
   * right: a message with no name cannot be the target of anything.
   */
  messages: {
    keyPath: "id",
    indexes: { byConversation: "conversationId", byClient: ["conversationId", "clientId"] },
  },
  /**
   * Reactions, keyed `conversation|target|device` so one person reacting twice
   * with the same emoji replaces rather than doubles.
   */
  reactions: { keyPath: "id", indexes: { byConversation: "conversationId" } },
  /** Unsent messages, in the order they were written. */
  outbox: { keyPath: "id", autoIncrement: true },
  drafts: { keyPath: "conversationId" },
  /** A story and the key that must be destroyed when it expires. */
  stories: { keyPath: "id" },
  /** Its key is nulled after the first successful opening; the row remains. */
  viewOnce: { keyPath: "clientId", indexes: { byConversation: "conversationId" } },
  folders: { keyPath: "id", autoIncrement: true },
  folderMembers: {
    keyPath: "id",
    indexes: { byFolder: "folderId", byConversation: "conversationId" },
  },
  pinnedMessages: { keyPath: "id", indexes: { byConversation: "conversationId" } },
  forgottenConversations: { keyPath: "id" },
  conversationPeers: { keyPath: "id", indexes: { byConversation: "conversationId" } },
  /** An inverted index kept in the same transaction as the message body. */
  searchTerms: {
    keyPath: "id",
    indexes: { byTerm: "term", byMessage: "messageId" },
  },
  /** The local unlock verifier and failed-attempt counter. */
  pin: { keyPath: "id" },
} as const;

export type StoreName = keyof typeof STORES;

/** The same word boundaries used when indexing and querying local messages. */
export function searchWords(body: string): string[] {
  return [...new Set(body.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
}

const V1_STORES: StoreName[] = [
  "account", "identity", "session", "mlsState", "conversations", "messages",
  "reactions", "outbox", "drafts",
];

const V2_STORES: StoreName[] = [
  "stories", "viewOnce", "folders", "folderMembers", "pinnedMessages",
  "forgottenConversations", "conversationPeers", "searchTerms",
  "pin",
];

/**
 * Opens the database, running the ladder if the version moved.
 *
 * `indexedDB` is injectable so tests can drive a real implementation rather
 * than a hand-written double: the thing that ships is the thing under test.
 */
export function openDatabase(
  name = "nexo",
  factory: IDBFactory = globalThis.indexedDB,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!factory) {
      reject(new Error("This browser has no IndexedDB, so there is nowhere to keep anything."));
      return;
    }
    const request = factory.open(name, SCHEMA_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const create = (names: StoreName[]) => {
        for (const storeName of names) {
          if (db.objectStoreNames.contains(storeName)) continue;
          const spec = STORES[storeName];
          const options: IDBObjectStoreParameters = { keyPath: spec.keyPath };
          if ("autoIncrement" in spec && spec.autoIncrement) options.autoIncrement = true;
          const store = db.createObjectStore(storeName, options);
          const indexes = "indexes" in spec ? spec.indexes : undefined;
          if (indexes) {
            for (const [indexName, path] of Object.entries(indexes)) {
              // An array path is a compound index. Passing it through as-is
              // rather than joining it: IndexedDB compares compound keys
              // element by element, which a joined string would not.
              store.createIndex(indexName, path as string | string[]);
            }
          }
        }
      };

      // Existing databases took rung 1 before the domains below existed.
      // Its definition is never changed after a released version has used it.
      if (event.oldVersion < 1) create(V1_STORES);
      if (event.oldVersion < 2) {
        create(V2_STORES);
        // A device upgrading from v1 already has messages. Search must find
        // them too, not only messages received after the new index exists.
        if (event.oldVersion >= 1) {
          const upgrade = request.transaction!;
          const existing = upgrade.objectStore("messages").getAll();
          existing.onsuccess = () => {
            const index = upgrade.objectStore("searchTerms");
            for (const row of existing.result as Array<{ id: number; body: string }>) {
              if (row.id < 0 || row.body.trim() === "") continue;
              for (const term of searchWords(row.body)) {
                index.put({ id: `${row.id}|${term}`, term, messageId: row.id });
              }
            }
          };
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("The local database would not open."));
    request.onblocked = () =>
      reject(new Error("Another tab is holding an older version of the database open."));
  });
}

/** One request, as a promise. */
function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The local database refused."));
  });
}

/**
 * Runs `work` inside one transaction and resolves when it has *committed*.
 *
 * Resolving on the last request rather than on `oncomplete` is the classic
 * IndexedDB mistake: the caller carries on believing the write landed, the
 * transaction aborts a moment later, and the data is gone with nothing to
 * catch. Waiting for the commit is what makes a write mean something.
 */
export async function transact<T>(
  db: IDBDatabase,
  names: StoreName | StoreName[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const tx = db.transaction(names as string | string[], mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("The write did not land."));
    tx.onabort = () => reject(tx.error ?? new Error("The write was abandoned."));
  });

  let result: T;
  try {
    result = await work(tx);
  } catch (error) {
    // A domain check may fail after earlier requests succeeded. Without an
    // explicit abort those writes could still commit despite the rejected
    // promise, defeating every caller's all-or-nothing assumption.
    try { tx.abort(); } catch { /* a failed request may already have aborted it */ }
    await done.catch(() => undefined);
    throw error;
  }
  await done;
  return result;
}

export const idb = {
  get: <T>(tx: IDBTransaction, store: StoreName, key: IDBValidKey): Promise<T | undefined> =>
    wrap(tx.objectStore(store).get(key) as IDBRequest<T | undefined>),

  getAll: <T>(tx: IDBTransaction, store: StoreName): Promise<T[]> =>
    wrap(tx.objectStore(store).getAll() as IDBRequest<T[]>),

  getAllByIndex: <T>(
    tx: IDBTransaction,
    store: StoreName,
    index: string,
    value: IDBValidKey | IDBKeyRange,
  ): Promise<T[]> =>
    wrap(tx.objectStore(store).index(index).getAll(value) as IDBRequest<T[]>),

  put: (tx: IDBTransaction, store: StoreName, value: unknown): Promise<IDBValidKey> =>
    wrap(tx.objectStore(store).put(value)),

  delete: (tx: IDBTransaction, store: StoreName, key: IDBValidKey): Promise<undefined> =>
    wrap(tx.objectStore(store).delete(key)),

  clear: (tx: IDBTransaction, store: StoreName): Promise<undefined> =>
    wrap(tx.objectStore(store).clear()),
};
