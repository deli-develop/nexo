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
  StoredTeamMark,
  StoredViewOnce,
  SearchHit,
  TeamRole,
} from "./store";
export { SCHEMA_VERSION } from "./idb";
export * as conversations from "./conversations";
export * as people from "./people";
export * as stories from "./stories";
export * as pin from "./pin";
export * as feed from "./feed";
export * as attachments from "./attachments";
export * as blocks from "./blocks";
export * as teams from "./teams";
export type { AddOutcome, PostDraft, TeamSummary } from "./teams";
export { buildBoard } from "./board";
export type {
  Board,
  BoardComment,
  BoardItem,
  BoardPost,
  BoardReaction,
  BoardState,
  UnreadableCard,
  UnsupportedCard,
} from "./board";
export type { RosterEntry } from "./roster";
export { Stream } from "./stream";
export type { Context, SyncOutcome } from "./conversations";
export type {
  Bucket,
  Comment,
  FeedPage,
  FeedSort,
  FollowState,
  MyProfile,
  Post,
  PostKind,
  Profile,
  ProfileEdit,
  ProfileLink,
  ReactionCount,
  Visibility,
  VisibilityField,
  VoteResult,
} from "./feed";
export type {
  EnvelopeEvent,
  PresenceEvent,
  MembershipEvent,
  ReceiptEvent,
  ServerEvent,
  StreamOptions,
  TypingEvent,
} from "./stream";
export {
  decodePayload,
  encodePayload,
  encodePayloadString,
  forwardedText,
  isReactionEmoji,
  MAX_PEAKS,
  TEAM_POST_MAX_FILES,
  payloadId,
  preview,
  voiceMeta,
} from "./payload";
export type {
  AttachmentPayload,
  EditPayload,
  Payload,
  ReactionPayload,
  RenamePayload,
  ReplyPayload,
  RetractPayload,
  SealedFile,
  TeamCommentPayload,
  TeamMetaPayload,
  TeamPinPayload,
  TeamPostPayload,
  TeamRemovePayload,
  TextPayload,
  UnsupportedPayload,
  VoiceMeta,
} from "./payload";
export type { CryptoModule, Decrypted, Device, Group, Member, Peeked, StagedCommit } from "./crypto";
export { bindWasm } from "./wasm";
export { bindPasswordWasm, bindObjectWasm } from "./wasm";
export type { WasmModule } from "./wasm";
export type {
  AttachmentContext,
  AttachmentMeta,
  ObjectCrypto,
  ObjectStore,
  SealedObject,
} from "./attachments";
export type { Block } from "./blocks";
export type { PinContext, PinStatus, PinStore } from "./pin";
export type { PeopleContext } from "./people";
export * from "./types";
export { Session } from "./session";
export type { PasswordCrypto, SessionOptions } from "./session";
