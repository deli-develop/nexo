/**
 * The wire, as TypeScript sees it.
 *
 * These mirror `crates/protocol/src/lib.rs`, which stays the authority: the
 * server is built from it, and a disagreement here is a bug here. Field names
 * are the JSON names, snake_case, rather than being camelised on arrival —
 * one translation at the edge of the app is easier to audit than a rename
 * spread through every call.
 */

/** Bumped on any breaking change to the types below. Must match the server. */
export const PROTOCOL_VERSION = 6;

/** What `/v1/auth/*` hands back. */
export interface SessionTokens {
  access_token: string;
  /** Long-lived, single-use, and **rotating**. See `transport.ts`. */
  refresh_token: string;
  /** Seconds until `access_token` expires. */
  expires_in: number;
  user_id: number;
  device_id: string;
}

/** Client-side Argon2id cost supplied by the server. */
export interface Argon2Params {
  memory_kib: number;
  iterations: number;
  parallelism: number;
}

/** The per-account salt and the Argon2id cost for this request. */
export interface SaltResponse {
  salt: string;
  argon2: Argon2Params;
}

/**
 * One envelope as the delivery service moves it. Opaque by design.
 *
 * The id field is `envelope_id`, not `id` — `EnvelopeView` in
 * `apps/server/src/delivery/mod.rs` renames the column on its way out, and a
 * client reading `id` gets `undefined`, writes a cursor of `NaN`, and resyncs
 * the same page for ever without ever reporting an error.
 */
export interface Envelope {
  envelope_id: number;
  conversation_id: string;
  sender_device_id: string;
  epoch: number;
  /** Hex. The server has no key for this and never will. */
  ciphertext: string;
  server_timestamp_ms: number;
  is_commit: boolean;
}

/** One member, and the device they are in the MLS group as. */
export interface MemberDevice {
  handle: string;
  device_id: string;
}

/** A conversation as the server lists it — membership and ordering only. */
export interface ConversationSummary {
  conversation_id: string;
  kind: string;
  epoch: number;
  latest_envelope_id: number | null;
  members: string[];
  /**
   * The same members paired with their device.
   *
   * MLS names a device, not an account, so this is the only place the mapping
   * exists — and removing somebody by handle is impossible without it.
   */
  member_devices?: MemberDevice[];
}

/**
 * What `send` answers with.
 *
 * No timestamp: the server returns the envelope's id and the epoch in force
 * after it, and nothing else. A sender that wants to show *when* uses its own
 * clock until the message comes back through `sync`.
 */
export interface Accepted {
  envelope_id: number;
  /** Changes only for a commit. */
  epoch: number;
}

/**
 * A KeyPackage claimed for somebody, spent by the claiming.
 *
 * No handle in the answer — the caller asked for one and already knows it.
 */
export interface ClaimedKeyPackage {
  device_id: string;
  /** Hex. */
  key_package: string;
}

/** How many KeyPackages this device still has waiting for it. */
export interface KeyPackageCount {
  remaining: number;
  /** Below this, top up. The server decides the threshold, not the client. */
  refill_below: number;
}

/** Somebody a search turned up. Public accounts only. */
export interface SearchResult {
  handle: string;
  display_name: string;
  avatar_key: string | null;
}

/** A freshly minted invitation. The secret is readable exactly once. */
export interface MintedInvite {
  id: number;
  secret: string;
  expires_at_ms: number;
}

/** One invitation afterwards. */
export interface InviteSummary {
  id: number;
  label: string | null;
  created_at_ms: number;
  expires_at_ms: number;
  revoked: boolean;
  live: boolean;
  used: number;
}

/** One story, as the server lists it. */
export interface StorySummary {
  id: number;
  author_handle: string;
  created_at_ms: number;
  expires_at_ms: number;
}
