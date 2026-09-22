/**
 * The client's brain, in TypeScript.
 *
 * What `crates/client` is for the desktop app, this is for every target — see
 * `docs/REWORK.md`. It has no React in it and no platform calls: the network
 * arrives as `Transport`, storage as `Store`, and MLS as `CryptoModule`, so
 * the same code runs in a browser, a WebView and Node's test runner.
 */

export { TransportError, asTransportError } from "./errors";
export type { TransportErrorKind } from "./errors";
export { Transport } from "./transport";
export type { TransportOptions } from "./transport";
export * as auth from "./auth";
export { Store } from "./store";
export type {
  Account,
  Identity,
  OutboxEntry,
  PinRecord,
  StoredConversation,
  StoredFolder,
  StoredMessage,
  StoredPeer,
  StoredReaction,
  StoredStory,
  StoredViewOnce,
  SearchHit,
} from "./store";
export { SCHEMA_VERSION } from "./idb";
export * as conversations from "./conversations";
export * as people from "./people";
export * as stories from "./stories";
export * as pin from "./pin";
export type { Context, SyncOutcome } from "./conversations";
export {
  decodePayload,
  encodePayload,
  encodePayloadString,
  isReactionEmoji,
  payloadId,
  preview,
} from "./payload";
export type {
  AttachmentPayload,
  EditPayload,
  Payload,
  ReactionPayload,
  RenamePayload,
  ReplyPayload,
  RetractPayload,
  TextPayload,
  UnsupportedPayload,
} from "./payload";
export type { CryptoModule, Decrypted, Device, Group, Peeked, StagedCommit } from "./crypto";
export { bindWasm } from "./wasm";
export { bindPasswordWasm } from "./wasm";
export type { WasmModule } from "./wasm";
export * from "./types";
export { Session } from "./session";
export type { PasswordCrypto, SessionOptions } from "./session";
