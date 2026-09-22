/**
 * What can go wrong at the network seam, and nothing else.
 *
 * A direct port of `crates/client/src/transport.rs`'s `TransportError`, kept
 * as the same five cases on purpose: the shell already distinguishes exactly
 * these when it decides what to tell somebody, and a richer set here would
 * only be flattened again on the way out.
 */
export type TransportErrorKind =
  /** The network, or a server that never answered. */
  | "unreachable"
  /** The access token is missing, expired past refreshing, or revoked. */
  | "invalid_credentials"
  /**
   * The server has no such thing.
   *
   * Separate from `rejected` because for some calls it is not a failure at
   * all — "there is no such story" is an ordinary answer, and a caller should
   * be able to say so without reading an error message to find out.
   */
  | "not_found"
  /** The server refused, and said why. */
  | "rejected"
  /**
   * A commit lost a race. The epoch in `currentEpoch` is the one now in force.
   *
   * MLS commits are strictly ordered and the first writer wins; a client that
   * meets this has to resync before trying again.
   */
  | "stale_epoch";

export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  /** Set only on `stale_epoch`: the epoch the server is actually in. */
  readonly currentEpoch?: number;

  constructor(kind: TransportErrorKind, message: string, currentEpoch?: number) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    if (currentEpoch !== undefined) this.currentEpoch = currentEpoch;
  }

  static unreachable(detail: string): TransportError {
    return new TransportError("unreachable", `Can't reach the server: ${detail}`);
  }
}

/** Narrows an unknown thrown value, for callers that must not assume. */
export function asTransportError(error: unknown): TransportError {
  return error instanceof TransportError
    ? error
    : new TransportError("rejected", error instanceof Error ? error.message : String(error));
}
