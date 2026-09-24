import { useEffect, useMemo, useState } from "react";
import {
  asConversationError,
  attachmentUrl,
  markVerified,
  saveAttachment,
  type AttachmentEntry,
} from "../../lib/conversations";
import { fileSize, relativeTime, safetyNumber } from "../../lib/format";
import { confirm, notify, openUrl } from "../../lib/native";
import { fieldFor, fileTone } from "../../lib/palette";
import type { Conversation, Message } from "../../lib/types";
import { IconButton } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { Panel } from "../../components/ui/Surface";
import { cn } from "../../lib/cn";
import { Lightbox } from "./Lightbox";
import { pinnedLine } from "./pinned";
import { sharedIn, type SharedAttachment } from "./shared";

/** How many of each list stand before "See all". */
const SHOWN = { media: 8, files: 3, links: 3 } as const;
type List = keyof typeof SHOWN;

/**
 * The 280px context panel (§6.1, §7.3).
 *
 * Everything in it comes from the local decrypted store — there is no
 * server-side index of what was shared in a conversation, and there cannot be
 * one: the server holds ciphertext (rule 4).
 *
 * The panel has no header of its own; its actions live in the top row, so the
 * column reads as one continuous strip from the window edge down.
 */
export function ContextPanel({
  conversation,
  now,
  onRefresh,
  messages = [],
  shape = "column",
}: {
  conversation: Conversation;
  now: Date;
  /// Re-reads conversations after something changed their stored state.
  onRefresh: () => Promise<void>;
  /// The open conversation, so pinned messages can be listed from it.
  messages?: Message[];
  /**
   * Where it is drawn. `column` is the 280px strip beside the chat, from
   * 1280px up. `screen` replaces the chat on a phone. `sheet` lies over the
   * chat's right edge in between, where a third column would squeeze the
   * conversation below a readable measure.
   */
  shape?: "column" | "screen" | "sheet";
}) {
  // Pinned on this device, newest first. Read from what is already loaded
  // rather than fetched: the list is the same messages, and a second source
  // would be a second thing to keep in step.
  const pinned = messages.filter((m) => m.pinned).reverse();
  // What was shared, from the history already loaded — see `sharedIn`.
  const shared = useMemo(() => sharedIn(messages), [messages]);
  // The lightbox steps oldest to newest, the way the conversation reads.
  const gallery = useMemo(() => [...shared.media].reverse().map(toEntry), [shared.media]);
  const [viewing, setViewing] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<List, boolean>>(COLLAPSED);
  useEffect(() => {
    setExpanded(COLLAPSED);
    setViewing(null);
  }, [conversation.id]);

  /** The part of a list that stands. */
  function shown<T>(list: List, items: T[]): T[] {
    return expanded[list] ? items : items.slice(0, SHOWN[list]);
  }
  /** The heading's way to the rest, when there is a rest. */
  function more(list: List, length: number) {
    if (length <= SHOWN[list]) return undefined;
    return {
      label: expanded[list] ? "Show fewer" : "See all",
      onClick: () => setExpanded((current) => ({ ...current, [list]: !current[list] })),
    };
  }

  return (
    <Panel
      tone={shape === "sheet" ? "raised" : "list"}
      edge={false}
      aria-label="Details"
      className={cn(
        "flex flex-col",
        shape === "column" && "w-[280px] shrink-0 border-l border-[var(--hairline)]",
        shape === "screen" && "min-w-0 flex-1",
        shape === "sheet" &&
          "absolute inset-y-0 right-0 z-20 w-[300px] max-w-full border-l border-line-strong",
      )}
    >
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5">
        {pinned.length > 0 ? (
          <section className="space-y-3">
            {/* "on this device" is not a nicety. A shared pin has no
                enforceable cap -- the server may not read a payload, so it
                cannot count -- so claiming everyone sees this would be a
                promise nothing here can keep. */}
            <SectionHead label="Pinned on this device" />
            <ul className="space-y-2">
              {pinned.map((message) => {
                const line = pinnedLine(message);
                return (
                  <li
                    key={message.id}
                    className="rounded-control bg-surface-2 px-3 py-2"
                  >
                    <p className="flex items-start gap-1.5">
                      {line.icon ? (
                        <Icon
                          name={line.icon}
                          size={12}
                          className="text-text-lo mt-[3px] shrink-0"
                        />
                      ) : null}
                      <span
                        className={cn(
                          "line-clamp-3 min-w-0 flex-1 text-[12px]",
                          // The app describing the message reads quieter than
                          // the message itself. A file name in the same weight
                          // as somebody's words reads as their words.
                          line.described
                            ? "text-text-lo italic"
                            : "text-text-body",
                        )}
                      >
                        {line.text}
                      </span>
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section className="space-y-3">
          <SectionHead
            label="Shared media"
            count={shared.media.length}
            more={more("media", shared.media.length)}
          />
          {shared.media.length === 0 ? (
            <p className="text-text-lo text-meta">Nothing shared yet.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {shown("media", shared.media).map((item, index) => (
                <MediaTile
                  key={item.attachment.id}
                  item={item}
                  // Newest first here, oldest first in the lightbox.
                  onOpen={() => setViewing(shared.media.length - 1 - index)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <SectionHead
            label="Shared files"
            count={shared.files.length}
            more={more("files", shared.files.length)}
          />
          <ul>
            {shown("files", shared.files).map(({ attachment, at }) => {
              const tone = fileTone(attachment.name);
              return (
                <li
                  key={attachment.id}
                  className="flex items-center gap-3 py-2"
                >
                  <span
                    className="text-text-hi flex size-9 shrink-0 items-center justify-center rounded-[10px] font-mono text-[9px] font-semibold"
                    style={{ background: tone.tint }}
                    aria-hidden="true"
                  >
                    {tone.label}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-text-hi block truncate text-meta">
                      {attachment.name}
                    </span>
                    <span className="text-text-lo block text-[11px]">
                      {relativeTime(at, now)} · {fileSize(attachment.size)}
                    </span>
                  </span>
                  <IconButton
                    name="download"
                    label={`Save ${attachment.name}`}
                    size={15}
                    onClick={() => void saveSharedFile(attachment)}
                  />
                </li>
              );
            })}
            {shared.files.length === 0 ? (
              <li className="text-text-lo text-meta">Nothing shared yet.</li>
            ) : null}
          </ul>
        </section>

        <section className="space-y-2">
          <SectionHead
            label="Shared links"
            count={shared.links.length}
            more={more("links", shared.links.length)}
          />
          <ul>
            {shown("links", shared.links).map(({ url, at }) => (
              <li key={url}>
                {/* Opened in the system browser, never here: a page loaded
                    in this WebView would share an origin with the session. */}
                <button
                  type="button"
                  onClick={() => void openUrl(url)}
                  title={url}
                  className="hover:bg-fill-hover rounded-control -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 px-2 py-2 text-left transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]"
                >
                  <span className="bg-fill text-text-mid flex size-9 shrink-0 items-center justify-center rounded-[10px]">
                    <Icon name="link" size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-text-hi block truncate text-meta">{hostOf(url)}</span>
                    <span className="text-text-lo block truncate text-[11px]">
                      {relativeTime(at, now)} · {url.replace(/^https:\/\//, "")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {shared.links.length === 0 ? (
              <li className="text-text-lo text-meta">Nothing shared yet.</li>
            ) : null}
          </ul>
        </section>

        <Encryption conversation={conversation} onVerified={onRefresh} />
      </div>

      {viewing !== null && gallery.length > 0 ? (
        <Lightbox items={gallery} startAt={viewing} now={now} onClose={() => setViewing(null)} />
      ) : null}
    </Panel>
  );
}

const COLLAPSED: Record<List, boolean> = { media: false, files: false, links: false };

/** What the lightbox asks for, from what the panel lists. */
function toEntry({ attachment, at, outgoing }: SharedAttachment): AttachmentEntry {
  return {
    envelope_id: Number(attachment.id),
    kind: attachment.kind === "video" ? "video" : "image",
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    sent_at_ms: at.getTime(),
    outgoing,
  };
}

/** The site a link goes to, which is what a list of them is read by. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * One picture or video, as a square in the grid.
 *
 * A picture is decrypted and drawn; a video is not, because a frame of it
 * would mean fetching and decoding the file for a 56px square. It gets the
 * field and a play mark instead, and the lightbox plays it. The object URL
 * is revoked when the tile goes, since nothing else will.
 */
function MediaTile({ item, onOpen }: { item: SharedAttachment; onOpen: () => void }) {
  const { attachment } = item;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (attachment.kind !== "image") return;
    let cancelled = false;
    let made: string | null = null;
    void attachmentUrl(Number(attachment.id))
      .then((next) => {
        if (cancelled) URL.revokeObjectURL(next);
        else {
          made = next;
          setUrl(next);
        }
      })
      .catch(() => {
        // The field stands. A tile that will not decrypt is not worth an
        // error in a list of what was shared.
      });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [attachment.id, attachment.kind]);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${attachment.name}`}
      title={attachment.name}
      className="rounded-control relative aspect-square w-full overflow-hidden bg-cover bg-center ring-1 ring-line-strong transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-state)] hover:opacity-80"
      style={url ? { backgroundImage: `url(${url})` } : { background: fieldFor(attachment.id) }}
    >
      {attachment.kind === "video" ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-6 items-center justify-center rounded-full bg-black/55 text-white">
            <Icon name="play" size={12} />
          </span>
        </span>
      ) : null}
    </button>
  );
}

/**
 * Sentence case, at reading size, with the overflow affordance on the right.
 * Tracked-out uppercase micro-labels are a habit, not a decision, and they
 * make every section shout the same volume as the content under it.
 */
function SectionHead({
  label,
  count,
  more,
}: {
  label: string;
  /** How many there are, when the list below may show fewer. */
  count?: number;
  more?: { label: string; onClick: () => void } | undefined;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-text-hi text-body font-medium">
        {label}
        {count ? (
          <span className="text-text-lo ml-1.5 font-mono text-[11px] font-normal">{count}</span>
        ) : null}
      </h2>
      {more ? (
        <button
          type="button"
          onClick={more.onClick}
          className="text-accent-soft text-[11px] transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-state)] hover:opacity-80"
        >
          {more.label}
        </button>
      ) : null}
    </div>
  );
}

/**
 * §4.1: the safety number is SHA-256 over both identity public keys, rendered
 * as 12 groups of 5 digits in the mono face so two people can read it aloud to
 * each other without ambiguity. M1 shows a mock number; M4 shows the real one.
 *
 * It states the unverified case in a sentence rather than a bordered warning
 * box. Unverified is the normal state of a new conversation — a standing alarm
 * for the normal state is how people learn to ignore alarms. The loud,
 * undismissable banner §4.1 asks for is for a key that *changes*, and that
 * arrives with real keys in M4.
 */
function Encryption({
  conversation,
  onVerified,
}: {
  conversation: Conversation;
  /// Re-reads the conversation, so the mark shows without waiting for a sync.
  onVerified: () => Promise<void>;
}) {
  const groups = safetyNumber(conversation.safetyDigits);

  // A group has no number to compare, and must not be offered one.
  //
  // A safety number is a fingerprint over *two* identity keys, so
  // `safety_number` returns nothing for a conversation with more than two
  // people in it. This panel used to render the compare-these-digits
  // instruction anyway, above an empty box, with a live "Mark as verified"
  // underneath -- and pressing it recorded a verification that had compared
  // nothing and then said so: "You compared these digits with this group and
  // they matched", beside a green shield. That is the overstatement rule 5
  // exists to prevent, in the one place in the app where being wrong about
  // what is proven matters most.
  //
  // "No number" is not only a group, though, and the group's sentence used to
  // be said about every conversation without one -- a DM whose other key this
  // device had not recorded was told it was "not a one-to-one conversation".
  // Each reason gets its own sentence, and none offers anything to compare.
  if (groups.length === 0) {
    const shutOut = conversation.unreadable === true;
    return (
      <section className="space-y-3">
        <SectionHead label="Encryption" />
        <p className="text-text-mid text-meta leading-relaxed">
          <Icon
            name={shutOut ? "key" : "shield"}
            size={13}
            className={`${shutOut ? "text-warning" : "text-text-lo"} mr-1.5 inline align-[-2px]`}
          />
          {shutOut ? (
            <>
              This device holds no keys for this conversation: it was set up
              for another device signed in as you. There is nothing here to
              compare, and nothing sent here can be opened on this one.
            </>
          ) : conversation.kind === "group" ? (
            <>
              Messages here are end-to-end encrypted, and only the people in
              this conversation can read them. There is nothing to compare:
              safety numbers are a fingerprint over two people&rsquo;s keys, so
              they exist in a one-to-one conversation and not in a group. To
              verify somebody here, open the conversation you have with them
              alone.
            </>
          ) : (
            <>
              Messages here are end-to-end encrypted. There is no safety number
              yet: it is a fingerprint over your key and {conversation.title}
              &rsquo;s, and this device has not recorded theirs. It appears
              after the conversation next syncs.
            </>
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHead label="Encryption" />

      <p className="text-text-mid text-meta leading-relaxed">
        {conversation.verified ? (
          <>
            <Icon
              name="shield"
              size={13}
              className="text-success mr-1.5 inline align-[-2px]"
            />
            You compared these digits with{" "}
            {conversation.kind === "dm" ? conversation.title : "this group"} and
            they matched.
          </>
        ) : (
          <>
            <Icon
              name="shield"
              size={13}
              className="text-text-lo mr-1.5 inline align-[-2px]"
            />
            Compare these digits over a channel you already trust. Until you do,
            nothing proves the keys belong to who you think.
          </>
        )}
      </p>

      <div className="rounded-control border border-line bg-fill px-3 py-2.5">
        <div className="text-text-mid grid grid-cols-4 gap-x-2 gap-y-1 text-center font-mono text-[11px] tracking-[0.02em]">
          {groups.map((group, index) => (
            <span key={`${group}-${index}`}>{group}</span>
          ))}
        </div>
      </div>

      <div className="flex items-center">
        <button
          type="button"
          onClick={async () => {
            if (conversation.verified) {
              await notify(
                "Compare again",
                "Read the digits above with the other side and confirm they match before marking it verified again.",
              );
              return;
            }
            const ok = await confirm(
              "Mark as verified",
              "Only confirm this if you've actually compared these digits with the other side and they matched.",
            );
            if (ok) {
              // Recorded in the store against the keys that are
              // current right now, so a later change clears it by itself.
              await markVerified(conversation.id);
              await onVerified();
            }
          }}
          className="text-accent-soft text-meta transition-opacity duration-[var(--motion-fast)] hover:opacity-80"
        >
          {conversation.verified ? "Compare again" : "Mark as verified"}
        </button>
      </div>
    </section>
  );
}

/**
 * Saves a file listed in the Shared panel.
 *
 * Same path as the bubble's download button, and the same rule 7 behaviour: a
 * failure is shown, never swallowed. Kept as a plain function rather than a
 * hook because this list has no per-row busy state to track -- the dialog is
 * the interaction, and it is modal.
 */
async function saveSharedFile(attachment: {
  id: string;
  name: string;
}): Promise<void> {
  try {
    await saveAttachment(Number(attachment.id));
  } catch (error) {
    await notify("Couldn't save that file", asConversationError(error).message);
  }
}
