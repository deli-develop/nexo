import { links } from "../../app/useLinkPreview";
import type { Attachment, Message } from "../../lib/types";

/** One attachment somebody sent, and when. */
export interface SharedAttachment {
  attachment: Attachment;
  at: Date;
  outgoing: boolean;
}

/** One link somebody sent, and when it was last sent. */
export interface SharedUrl {
  url: string;
  at: Date;
  outgoing: boolean;
}

export interface Shared {
  /** Pictures and video — what the lightbox can show. Newest first. */
  media: SharedAttachment[];
  /** Everything else that was sent as a file. Newest first. */
  files: SharedAttachment[];
  /** Every https link in a message body, once each. Newest first. */
  links: SharedUrl[];
}

/**
 * What a conversation has shared, read from its history.
 *
 * The context panel's three lists said "Nothing shared yet" in every
 * conversation, however many photos were in it, because they were never fed:
 * the comment beside them said nothing indexes attachments per conversation.
 * Nothing needs to. The open conversation's whole history is already in
 * memory — `conversationMessages` reads all of it — and every attachment in
 * it is on its message. This reads them from there, as the pinned list does.
 *
 * Left out, each for a reason:
 *
 * - **Taken-back and unreadable messages.** A retraction the panel kept
 *   showing would not be one, and a message that would not decrypt has
 *   nothing to show (rule 7).
 * - **View-once media.** It is a payload of its own and never carries an
 *   attachment here, which is the point: a gallery that kept a copy in view
 *   would undo the one thing it promises.
 * - **Voice notes.** Something somebody said, not a file they sent. They
 *   stay in the conversation, where they are played.
 *
 * Links count once each, at the last time they were sent — the same link
 * posted three times is one thing that was shared.
 */
export function sharedIn(messages: Message[]): Shared {
  const media: SharedAttachment[] = [];
  const files: SharedAttachment[] = [];
  const urls = new Map<string, SharedUrl>();

  for (const message of messages) {
    if (message.retracted || message.undecryptable) continue;
    const outgoing = message.authorId === "me";

    for (const attachment of message.attachments ?? []) {
      const entry = { attachment, at: message.at, outgoing };
      if (attachment.kind === "image" || attachment.kind === "video") media.push(entry);
      else if (attachment.kind !== "voice") files.push(entry);
    }

    for (const url of links(message.body)) {
      // History is oldest first, so a later sending replaces an earlier one.
      urls.delete(url);
      urls.set(url, { url, at: message.at, outgoing });
    }
  }

  return {
    media: media.reverse(),
    files: files.reverse(),
    links: [...urls.values()].reverse(),
  };
}
