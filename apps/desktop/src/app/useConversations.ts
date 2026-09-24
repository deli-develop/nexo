import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  asConversationError,
  conversationMessages,
  listConversations,
  safetyNumber,
  sendMessage,
  sendAttachment,
  sendVoiceMessage,
  sendReply as sendReplyMessage,
  sendViewOnce,
  sendSticker as sendStickerMessage,
  type Conversation as WireConversation,
  type Message as WireMessage,
} from "../lib/conversations";
import { attachmentKind } from "../lib/media";
import type { Conversation, Message } from "../lib/types";
import { useApp } from "./store";
import { onSync, syncNow } from "./syncAgent";
import type { Recording } from "../features/messages/useRecorder";
/**
 * Live conversation data, in the shapes the UI already renders.
 *
 * `lib/types` says it: *"M1 fills these from `src/mock`. M4 fills them from the
 * core. Nothing else about the components changes when it does."* This is that
 * swap — the mapping happens here so no component has to know where its data
 * came from.
 *
 * The pulling itself lives in the sync agent (`syncAgent.ts`), which this hook
 * subscribes to. Sync consumes envelopes, so exactly one caller may run it —
 * a second poller here would race the agent and each would see half the
 * arrivals. This hook's own job is reading what the agent already wrote to
 * the local store, in the shapes the components render.
 */

/** Our own device, for `authorId`. Messages we sent carry no sender. */
const ME = "me";

function toConversation(wire: WireConversation): Conversation {
  return {
    id: wire.conversation_id,
    kind: wire.kind === "group" ? "group" : "dm",
    // A conversation joined from a Welcome has no title until M7's profile
    // fetch. Saying so is better than inventing a name or showing a UUID.
    title: wire.title ?? "Unnamed conversation",
    memberIds: wire.members,
    unread: 0,
    // From the store now, not from a browser boolean. The old one
    // survived key changes it knew nothing about.
    verified: wire.verified,
    keyChanged: wire.key_changed,
    keyChangedAtMs: wire.key_changed_at_ms,
    safetyDigits: "",
    muted: false,
    hasAvatar: wire.has_avatar,
    // Spread rather than assigned: `exactOptionalPropertyTypes` is on, so an
    // optional field is either absent or a value, never explicitly undefined.
    ...(wire.last_message_at_ms !== null
      ? { lastMessageAt: new Date(wire.last_message_at_ms) }
      : {}),
    // The preview the core computed, carried through rather than dropped: the
    // list cannot recompute it, because it holds no history for a conversation
    // that is not open.
    ...(wire.last_message !== null ? { lastMessage: wire.last_message } : {}),
    ...(wire.last_message_outgoing !== null
      ? { lastMessageOutgoing: wire.last_message_outgoing }
      : {}),
  };
}

function toMessage(wire: WireMessage, conversationId: string): Message {
  return {
    id: String(wire.envelope_id),
    conversationId,
    authorId: wire.outgoing ? ME : (wire.sender_device_id ?? "them"),
    body: wire.body,
    at: new Date(wire.sent_at_ms),
    // A message still in the offline queue is "sending" — drawn with the
    // clock, because telling someone it was sent while it sits in an outbox
    // is the one lie a messenger cannot afford (rule 7). Everything else in
    // the local store was accepted by the server before it was written, so
    // "sent" is the honest floor there.
    state: wire.pending ? "sending" : "sent",
    ...(wire.client_id ? { clientId: wire.client_id } : {}),
    ...(wire.sticker ? { sticker: wire.sticker } : {}),
    ...(wire.view_once
      ? {
          viewOnce: {
            openable: wire.view_once.openable,
            outgoing: wire.view_once.outgoing,
            kind: wire.view_once.kind,
            ...(wire.view_once.opened_at_ms !== undefined
              ? { openedAtMs: wire.view_once.opened_at_ms }
              : {}),
          },
        }
      : {}),
    ...(wire.reply
      ? {
          replyTo: {
            target: wire.reply.target,
            found: wire.reply.found,
            outgoing: wire.reply.outgoing,
            retracted: wire.reply.retracted,
            excerpt: wire.reply.excerpt,
            ...(wire.reply.envelope_id !== undefined
              ? { envelopeId: wire.reply.envelope_id }
              : {}),
          },
        }
      : {}),
    ...(wire.forwarded ? { forwarded: true } : {}),
    ...(wire.forwarded_from ? { forwardedFrom: wire.forwarded_from } : {}),
    ...(wire.unsupported ? { unsupported: wire.unsupported } : {}),
    ...(wire.pinned ? { pinned: true } : {}),
    ...(wire.reactions.length > 0 ? { reactions: wire.reactions } : {}),
    ...(wire.retracted_at_ms !== null ? { retracted: true } : {}),
    ...(wire.edited_at_ms !== null ? { edited: true } : {}),
    // `exactOptionalPropertyTypes` is on, so an optional property is either
    // absent or a value -- never explicitly undefined. Spreading is how you
    // say "absent" without turning the field into `T | undefined`.
    //
    // One attachment per message: the payload inside the ciphertext carries
    // one file, so a list of one is the honest shape rather than a hint that
    // several are possible.
    ...(wire.attachment
      ? {
          attachments: [
            {
              id: String(wire.envelope_id),
              name: wire.attachment.name,
              size: wire.attachment.size,
              mime: wire.attachment.mime,
              kind: attachmentKind(
                wire.attachment.mime,
                wire.attachment.voice !== undefined,
              ),
              ...(wire.attachment.voice
                ? {
                    voice: {
                      durationMs: wire.attachment.voice.duration_ms,
                      peaks: wire.attachment.voice.peaks,
                    },
                  }
                : {}),
              ...(wire.attachment.streamable ? { streamable: true } : {}),
            },
          ],
        }
      : {}),
  };
}

export interface LiveConversations {
  conversations: Conversation[];
  messages: Message[];
  safety: string | null;
  /** Non-null when something is wrong the user should see. */
  problem: string | null;
  loading: boolean;
  send: (body: string) => Promise<void>;
  /**
   * Sends a file the user already picked.
   *
   * The bytes, not a path: a browser never learns a path, and one shape has to
   * work on every host this page runs on.
   */
  sendFile: (
    file: { name: string; mime: string; bytes: Uint8Array },
    body?: string,
  ) => Promise<void>;
  /** Sends something the user just recorded. */
  sendVoice: (recording: Recording) => Promise<void>;
  /** Sends a message answering another one, by that message's name. */
  sendReply: (body: string, target: string) => Promise<void>;
  /** Sends a picture or clip the other person can open once. */
  sendOnce: (file: { mime: string; bytes: Uint8Array }) => Promise<void>;
  /** Sends a sticker by name. */
  sendSticker: (pack: string, stickerId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useConversations(
  activeId: string | undefined,
): LiveConversations {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [safety, setSafety] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Guards against a slow response for a conversation the user has already
  // navigated away from overwriting the one they are looking at.
  const wanted = useRef<string | undefined>(activeId);
  wanted.current = activeId;

  const loadList = useCallback(async () => {
    try {
      const wire = await listConversations();
      // A team is a conversation underneath and is not one here: its posts
      // are read on its board, and a row for it in Messages would open a chat
      // view of something that is not a chat.
      setConversations(wire.filter((c) => c.kind !== "team").map(toConversation));
    } catch (error) {
      const e = asConversationError(error);
      // Not being signed in is the ordinary state before login, not a problem
      // to shout about.
      if (e.kind !== "signed_out") setProblem(e.message);
    }
  }, []);

  const loadMessages = useCallback(async (id: string | undefined) => {
    if (!id) {
      setMessages([]);
      setSafety(null);
      return;
    }
    try {
      const [wire, digits] = await Promise.all([
        conversationMessages(id),
        safetyNumber(id).catch(() => null),
      ]);
      if (wanted.current !== id) return;
      setMessages(wire.map((m) => toMessage(m, id)));
      setSafety(digits);
    } catch (error) {
      const e = asConversationError(error);
      if (e.kind !== "signed_out") setProblem(e.message);
    }
  }, []);

  const refresh = useCallback(async () => {
    // The agent owns the sync; this asks it for a pass now and then re-reads.
    const result = await syncNow();
    // Rule 7: an envelope that could not be read is reported, never hidden.
    if (result && result.failed > 0) {
      setProblem(
        result.failed === 1
          ? "1 message couldn't be decrypted."
          : `${result.failed} messages couldn't be decrypted.`,
      );
    } else {
      setProblem(null);
    }
    await loadList();
    await loadMessages(wanted.current);
  }, [loadList, loadMessages]);

  // First load, then re-read after every one of the agent's sync passes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (!cancelled) setLoading(false);
    })();

    const unsubscribe = onSync((result) => {
      if (cancelled) return;
      if (result.failed > 0) {
        setProblem(
          result.failed === 1
            ? "1 message couldn't be decrypted."
            : `${result.failed} messages couldn't be decrypted.`,
        );
      }
      void loadList();
      void loadMessages(wanted.current);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refresh, loadList, loadMessages]);

  // The conversation on screen is being read — when someone is actually
  // looking: opened by a click, or reloaded while the window has focus. An
  // unfocused window keeps its counts; the agent's focus listener clears them
  // the moment the person returns.
  const clearUnread = useApp((s) => s.clearUnread);
  const unreadMap = useApp((s) => s.unread);
  useEffect(() => {
    if (activeId && messages.length >= 0 && document.hasFocus())
      clearUnread(activeId);
  }, [activeId, clearUnread, messages.length]);

  // Switching conversation reloads immediately rather than waiting for a tick.
  useEffect(() => {
    void loadMessages(activeId);
  }, [activeId, loadMessages]);

  const send = useCallback(
    async (body: string) => {
      if (!activeId) return;
      try {
        const sent = await sendMessage(activeId, body);
        // Appended rather than re-fetched: the round trip already happened, and
        // waiting for a second one to see your own message is the kind of delay
        // that makes an app feel broken.
        setMessages((current) => [...current, toMessage(sent, activeId)]);
        setProblem(null);
        void loadList();
      } catch (error) {
        setProblem(asConversationError(error).message);
      }
    },
    [activeId, loadList],
  );

  const sendFile = useCallback(
    async (file: { name: string; mime: string; bytes: Uint8Array }, body?: string) => {
      if (!activeId) return;
      try {
        const sent = await sendAttachment(activeId, file, body);
        setMessages((current) => [...current, toMessage(sent, activeId)]);
        setProblem(null);
        void loadList();
      } catch (error) {
        setProblem(asConversationError(error).message);
      }
    },
    [activeId, loadList],
  );

  const sendReply = useCallback(
    async (body: string, target: string) => {
      if (!activeId) return;
      try {
        const sent = await sendReplyMessage(activeId, body, target);
        setMessages((current) => [...current, toMessage(sent, activeId)]);
        setProblem(null);
        void loadList();
      } catch (error) {
        setProblem(asConversationError(error).message);
      }
    },
    [activeId, loadList],
  );

  const sendOnce = useCallback(
    async (file: { mime: string; bytes: Uint8Array }) => {
      if (!activeId) return;
      try {
        const sent = await sendViewOnce(activeId, file);
        setMessages((current) => [...current, toMessage(sent, activeId)]);
        setProblem(null);
        void loadList();
      } catch (error) {
        setProblem(asConversationError(error).message);
      }
    },
    [activeId, loadList],
  );

  const sendSticker = useCallback(
    async (pack: string, stickerId: string) => {
      if (!activeId) return;
      try {
        const sent = await sendStickerMessage(activeId, pack, stickerId);
        setMessages((current) => [...current, toMessage(sent, activeId)]);
        setProblem(null);
        void loadList();
      } catch (error) {
        setProblem(asConversationError(error).message);
      }
    },
    [activeId, loadList],
  );

  const sendVoice = useCallback(
    async (recording: Recording) => {
      if (!activeId) return;
      try {
        const sent = await sendVoiceMessage(
          activeId,
          recording.blob,
          recording.durationMs,
          recording.peaks,
        );
        setMessages((current) => [...current, toMessage(sent, activeId)]);
        setProblem(null);
        void loadList();
      } catch (error) {
        setProblem(asConversationError(error).message);
      }
    },
    [activeId, loadList],
  );

  // The unread ledger lives in the store (the sync agent writes it); the rows
  // just wear it. Mapped here so no component has to know where it comes from.
  const withUnread = useMemo(
    () => conversations.map((c) => ({ ...c, unread: unreadMap[c.id] ?? 0 })),
    [conversations, unreadMap],
  );

  return useMemo(
    () => ({
      conversations: withUnread,
      messages,
      safety,
      problem,
      loading,
      send,
      sendFile,
      sendVoice,
      sendReply,
      sendOnce,
      sendSticker,
      refresh,
    }),
    [
      withUnread,
      messages,
      safety,
      problem,
      loading,
      send,
      sendFile,
      sendVoice,
      sendReply,
      sendOnce,
      sendSticker,
      refresh,
    ],
  );
}
