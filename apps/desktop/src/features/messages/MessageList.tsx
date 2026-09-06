import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../app/store";
import { firstLink, useLinkPreview } from "../../app/useLinkPreview";
import { cn } from "../../lib/cn";
import { clockTime, dayDivider, fileSize, isSameDay } from "../../lib/format";
import {
  confirm,
  copyText,
  notify,
  openUrl,
  pickSavePath,
} from "../../lib/native";
import {
  deleteMessageForMe,
  openViewOnce,
  reactToMessage,
  reviseMessage,
  setMessagePinned,
} from "../../lib/conversations";
import { EmojiPicker } from "../../components/ui/EmojiPicker";
import { StickerArt, findSticker } from "../../components/ui/stickers";

/**
 * How long a message stays editable, matching `nexo_protocol::window`.
 *
 * The UI's copy of a rule the sender is held to anyway. The receiver allows a
 * minute more, which is not this number's business — see the Rust module for
 * why the two differ.
 */
const EDIT_WINDOW_MS = 10 * 60 * 1000;
import {
  asConversationError,
  attachmentDataUrl,
  streamUrl,
  conversationAttachments,
  saveAttachmentTo,
  type AttachmentEntry,
} from "../../lib/conversations";
import { Waveform } from "./Composer";
import { formatDuration } from "./useRecorder";
import { fieldFor, fileTone } from "../../lib/palette";
import type {
  Attachment,
  Conversation,
  Message,
  QuotedMessage,
} from "../../lib/types";
import { Avatar } from "../../components/ui/Avatar";
import { HandleAvatar } from "../../components/ui/HandleAvatar";
import { jumpToMessage } from "./jump";
import { peerHandle } from "./peer";
import { clickSelection, type SelectionState } from "./selection";
import { IconButton } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { DeliveryTick } from "./ConversationList";
import { Lightbox } from "./Lightbox";
import { useContextMenu } from "../../components/ui/ContextMenu";
import { messageMenuItems } from "./menu";
import { isPlayable } from "../../lib/media";

/** Messages from the same person inside five minutes are one run (§6.1). */
const RUN_WINDOW_MS = 5 * 60_000;

interface Row {
  message: Message;
  /** First of a run: gets the avatar and the name. */
  startsRun: boolean;
  /** Last of a run: gets the timestamp and the delivery tick. */
  endsRun: boolean;
  divider?: string;
}

export function buildRows(messages: Message[], now: Date): Row[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const newDay = !previous || !isSameDay(previous.at, message.at);
    const startsRun =
      newDay ||
      !previous ||
      previous.authorId !== message.authorId ||
      message.at.getTime() - previous.at.getTime() > RUN_WINDOW_MS;
    const endsRun =
      !next ||
      next.authorId !== message.authorId ||
      !isSameDay(next.at, message.at) ||
      next.at.getTime() - message.at.getTime() > RUN_WINDOW_MS;
    return {
      message,
      startsRun,
      endsRun,
      ...(newDay ? { divider: dayDivider(message.at, now) } : {}),
    };
  });
}

export function MessageList({
  messages,
  now,
  conversation,
  onChanged,
  onReply,
  onForward,
}: {
  messages: Message[];
  now: Date;
  conversation: Conversation;
  /** Pinning or deleting changed the local store; reload from it. */
  onChanged?: () => void;
  /** Start answering this message. The composer takes it from here. */
  onReply?: (message: Message) => void;
  onForward?: (message: Message) => void;
}) {
  const rows = buildRows(messages, now);

  // The first message you had not read when you opened this, by its id.
  //
  // The mark is a *count* of unread incoming messages, taken at the moment
  // opening the conversation marked them read — so the boundary is that many
  // incoming messages back from the end. Counting from the end rather than
  // storing an id is what makes it survive a sync arriving while you read:
  // those messages are newer than the line, so the line stays where it was.
  // Several messages at once: copying a run of them, or clearing them out.
  //
  // The rules are `selection.ts`, unchanged and already tested — the same ones
  // the conversation list uses, because Ctrl and Shift have to mean the same
  // thing in both places or neither is learnable. Only the ids differ: rows
  // here are envelope ids, which are numbers, so they are stringified at the
  // boundary rather than making the rules generic over both.
  const [selection, setSelection] = useState<SelectionState>({
    selected: new Set<string>(),
    anchor: null,
    open: false,
  });
  const conversationId = conversation.id;
  useEffect(() => {
    setSelection({ selected: new Set<string>(), anchor: null, open: false });
  }, [conversationId]);

  const mark = useApp((s) => s.unreadMark[conversation.id]) ?? 0;
  const firstUnreadId = useMemo(() => {
    if (mark <= 0) return null;
    const incoming = messages.filter((m) => m.authorId !== "me");
    const target = incoming[incoming.length - mark];
    return target ? target.id : null;
  }, [messages, mark]);
  const scroller = useRef<HTMLDivElement>(null);
  const count = messages.length;

  // Whether the newest message is on screen. Not a scroll position but a
  // question about intent: someone reading back through a conversation has not
  // asked to be yanked to the bottom because somebody typed.
  // Loaded once when something is opened, not on every render: it is a read of
  // the local store, but the whole conversation's worth.
  const [media, setMedia] = useState<AttachmentEntry[] | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  const openMedia = useCallback(
    async (envelopeId: number) => {
      const all = media ?? (await conversationAttachments(conversation.id));
      if (!media) setMedia(all);
      // Only what can actually be shown. A PDF in the strip would be a
      // thumbnail of nothing with no way to view it.
      const shown = all.filter((a) => a.kind === "image" || a.kind === "video");
      const at = shown.findIndex((a) => a.envelope_id === envelopeId);
      if (at >= 0) setViewing(at);
    },
    [conversation.id, media],
  );

  const shownMedia = (media ?? []).filter(
    (a) => a.kind === "image" || a.kind === "video",
  );

  const [atBottom, setAtBottom] = useState(true);
  // How many arrived while they were reading back. Reset the moment the bottom
  // is reached again, however they got there.
  const [missed, setMissed] = useState(0);
  const seen = useRef(count);

  // Scrolling to a quoted message, and saying which one you landed on.
  //
  // The flash is not decoration: in a wall of similar-looking bubbles, arriving
  // somewhere with no signal leaves you unsure whether anything happened.
  // `jump.ts` holds it, because stepping through search results has to land
  // exactly the same way.
  const jumpTo = useCallback((envelopeId: number) => {
    jumpToMessage(envelopeId);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // A few pixels of slack: a list can sit a fraction of a pixel short of the
    // bottom after a resize, and treating that as "scrolled up" would leave the
    // button on screen permanently.
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAtBottom(bottom);
    if (bottom) {
      setMissed(0);
      seen.current = count;
    }
  }, [count]);

  // A chat opens at the newest message, and stays there when one arrives --
  // unless the reader has scrolled away, in which case the new ones are
  // counted instead of chased.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
      seen.current = count;
      setMissed(0);
    } else {
      setMissed(Math.max(0, count - seen.current));
    }
    // `atBottom` is deliberately not a dependency: this reacts to messages
    // arriving, and including it would re-run on every scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="h-full overflow-y-auto"
      >
        <ol className="mt-auto flex flex-col gap-0.5 px-4 py-4">
          {rows.map((row, index) => (
            <li
              key={row.message.id}
              className="contents"
              onClick={(event) => {
                // A plain click clears, it never selects: a bulk action must
                // not be able to gather rows by accident.
                setSelection((current) =>
                  clickSelection(
                    rows.map((r) => String(r.message.id)),
                    current,
                    String(row.message.id),
                    {
                      toggle: event.ctrlKey || event.metaKey,
                      range: event.shiftKey,
                    },
                  ),
                );
              }}
            >
              {row.divider ? <DayDivider label={row.divider} /> : null}
              {row.message.id === firstUnreadId ? <UnreadDivider /> : null}
              <Bubble
                row={row}
                index={index}
                conversation={conversation}
                onOpenMedia={(id) => void openMedia(id)}
                onReply={onReply}
                onForward={onForward}
                onJumpTo={jumpTo}
                onChangedHere={() => onChanged?.()}
                onRevise={async (target, body) => {
                  await reviseMessage(conversation.id, target, body);
                  onChanged?.();
                }}
                onReact={async (target, emoji, on) => {
                  await reactToMessage(conversation.id, target, emoji, on);
                  onChanged?.();
                }}
                onPinnedChange={async (envelopeId, pinned) => {
                  await setMessagePinned(conversation.id, envelopeId, pinned);
                  onChanged?.();
                }}
                onDeleteForMe={async (envelopeId) => {
                  // Named in the confirmation, not just in the menu: this is
                  // the difference the person is actually choosing.
                  const ok = await confirm(
                    "Delete for me",
                    "This removes the message from this device. Everyone else keeps their copy.",
                  );
                  if (!ok) return;
                  await deleteMessageForMe(conversation.id, envelopeId);
                  onChanged?.();
                }}
              />
            </li>
          ))}
        </ol>
      </div>

      {viewing !== null && shownMedia.length > 0 ? (
        <Lightbox
          items={shownMedia}
          startAt={viewing}
          now={now}
          onClose={() => setViewing(null)}
        />
      ) : null}

      {selection.selected.size > 0 ? (
        <SelectionBar
          count={selection.selected.size}
          onCopy={() => {
            // In the order they are drawn, not the order they were clicked:
            // pasted somewhere else it has to read like the conversation.
            const text = rows
              .filter((r) => selection.selected.has(String(r.message.id)))
              .map((r) => r.message.body)
              .filter((body) => body.length > 0)
              .join("\n");
            void copyText(text);
          }}
          onDelete={async () => {
            const ok = await confirm(
              selection.selected.size === 1
                ? "Delete this message here?"
                : `Delete ${selection.selected.size} messages here?`,
              "They go from this device only. Everyone else keeps their copy — taking a message back for everyone is a different thing, and it is in the message's own menu.",
            );
            if (!ok) return;
            for (const id of selection.selected) {
              await deleteMessageForMe(conversation.id, Number(id));
            }
            setSelection({ selected: new Set<string>(), anchor: null, open: false });
            onChanged?.();
          }}
          onClear={() =>
            setSelection({ selected: new Set<string>(), anchor: null, open: false })
          }
        />
      ) : null}

      {!atBottom && selection.selected.size === 0 ? (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label={
            missed > 0
              ? `${missed} new messages, jump to the latest`
              : "Jump to the latest"
          }
          className="rounded-full bg-surface-2 text-text-hi ring-line-strong absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 px-3 py-2 shadow-lg ring-1 transition-colors duration-[var(--motion-fast)] hover:bg-fill-hover"
        >
          <Icon name="chevronLeft" size={14} className="-rotate-90" />
          {missed > 0 ? (
            <span className="bg-accent text-on-accent rounded-full px-1.5 py-0.5 font-mono text-[11px] tabular-nums">
              {missed}
            </span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}

/**
 * What to do with the messages you have picked.
 *
 * Sits where the jump-to-latest button sits and replaces it while a selection
 * exists, because two floating controls in the same corner is one too many and
 * the selection is the more urgent of the two.
 *
 * Delete is last, as every destructive entry in this app is — the same
 * ordering the message menu asserts in `menu.test.ts`.
 */
function SelectionBar({
  count,
  onCopy,
  onDelete,
  onClear,
}: {
  count: number;
  onCopy: () => void;
  onDelete: () => void | Promise<void>;
  onClear: () => void;
}) {
  return (
    <div className="rounded-full bg-surface-2 ring-line-strong absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 px-2 py-1.5 shadow-lg ring-1">
      <span className="text-text-mid px-1.5 text-meta tabular-nums">
        {count} selected
      </span>
      <IconButton name="copy" label="Copy the selected messages" size={16} onClick={onCopy} />
      <IconButton
        name="trash"
        label="Delete the selected messages here"
        size={16}
        onClick={() => void onDelete()}
      />
      <IconButton name="close" label="Clear the selection" size={16} onClick={onClear} />
    </div>
  );
}

/**
 * Where you stopped reading.
 *
 * Drawn in the accent rather than the hairline the day divider uses, because
 * the two say different things: one is a fact about the calendar, this one is
 * about you, and a reader scanning back up needs to find it without reading
 * any of it.
 */
function UnreadDivider() {
  return (
    <div
      className="my-3 flex items-center gap-3"
      role="separator"
      aria-label="Unread messages"
    >
      <span className="bg-accent/40 h-px flex-1" />
      <span className="text-accent-soft text-[11px] font-medium tracking-[0.06em] uppercase">
        Unread
      </span>
      <span className="bg-accent/40 h-px flex-1" />
    </div>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div
      className="my-3 flex items-center gap-3"
      role="separator"
      aria-label={label}
    >
      <span className="h-px flex-1 bg-[var(--hairline)]" />
      <span className="text-text-lo text-[11px] font-medium tracking-[0.06em] uppercase">
        {label}
      </span>
      <span className="h-px flex-1 bg-[var(--hairline)]" />
    </div>
  );
}

/**
 * The quoted message above a reply.
 *
 * Three states, and they are genuinely different things to a reader: the
 * message is here and can be jumped to, it was taken back, or this device never
 * received it. The last is ordinary — somebody joined the conversation after
 * the message being answered — so it says that rather than drawing a blank line
 * that looks like a bug.
 *
 * Only the first is a button. A quote you cannot go to must not look like one
 * you can.
 */
function QuoteBlock({
  quote,
  mine,
  onJumpTo,
}: {
  quote: QuotedMessage;
  mine: boolean;
  onJumpTo: (envelopeId: number) => void;
}) {
  const label = quote.retracted
    ? "This message was taken back"
    : !quote.found
      ? "Not on this device"
      : quote.excerpt;

  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "w-[2px] shrink-0 self-stretch rounded-full",
          quote.found && !quote.retracted ? "bg-accent-soft" : "bg-line-strong",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-left">
        <span className="text-text-mid block text-[11px] font-medium">
          {quote.outgoing ? "You" : "Them"}
        </span>
        <span
          className={cn(
            "block truncate text-[12px]",
            quote.found && !quote.retracted
              ? "text-text-lo"
              : "text-text-lo italic",
          )}
        >
          {label}
        </span>
      </span>
    </>
  );

  const shell = cn(
    "rounded-control bg-surface-3/60 mb-1 flex max-w-full items-stretch gap-2 px-2 py-1",
    mine ? "ml-auto" : "mr-auto",
  );

  if (!quote.found || quote.envelopeId === undefined) {
    return <span className={shell}>{body}</span>;
  }
  return (
    <button
      type="button"
      className={cn(shell, "hover:bg-surface-3 cursor-pointer text-left")}
      onClick={() => onJumpTo(quote.envelopeId as number)}
      aria-label="Go to the message this answers"
    >
      {body}
    </button>
  );
}

/**
 * A sticker, drawn from art this build already has.
 *
 * No bubble behind it. A sticker is a picture somebody chose, and a chrome
 * container around it makes it look like an attachment — which is exactly what
 * it is not.
 *
 * A pack or an id this build does not know is drawn as a placeholder saying so,
 * rather than as nothing. That is the cost of naming art instead of sending it,
 * and it is the same failure `UnsupportedBubble` handles: somebody is running a
 * newer Nexo, and the remedy is an update rather than asking them to resend.
 */
function StickerBubble({ sticker }: { sticker: { pack: string; id: string } }) {
  const art = findSticker(sticker.pack, sticker.id);
  if (!art) {
    return (
      <div className="rounded-bubble border-line text-text-lo flex items-center gap-2 border border-dashed px-3 py-2 text-meta">
        <Icon name="refresh" size={14} className="shrink-0" />
        A sticker this version does not have yet
      </div>
    );
  }
  return <StickerArt sticker={art} size={128} />;
}

/**
 * A picture or clip meant to be opened once.
 *
 * Three states, and the wording of each is the feature.
 *
 * **Unopened.** A cover, not a blurred preview: blurring implies the picture is
 * already here and merely obscured, and someone will try to unblur it. Nothing
 * is fetched until it is opened, so there is nothing to obscure.
 *
 * **Opened.** The key is gone from this device, so the bubble says exactly
 * that. Not "expired", which suggests a clock, and not "deleted", which
 * suggests somewhere it went.
 *
 * **Ours.** We kept the file we picked, so there was never anything here for us
 * to open — the bubble says it was sent rather than pretending to be spent.
 *
 * What it never says: that the other person cannot keep it. They can photograph
 * the screen, and `docs/THREAT-MODEL.md` §4 puts the viewer's own device out of
 * scope. Claiming otherwise would be the comfortable lie rule 5 exists to stop.
 */
function ViewOnceBubble({
  message,
  onOpenChanged,
}: {
  message: Message;
  onOpenChanged: () => void;
}) {
  const state = message.viewOnce;
  const [showing, setShowing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!state) return null;

  const noun = state.kind === "video" ? "Video" : "Photo";

  async function open() {
    if (!message.clientId || busy) return;
    setBusy(true);
    try {
      const url = await openViewOnce(message.clientId);
      setShowing(url);
      // The key is gone now, so every other view of this message is wrong
      // until it reloads.
      onOpenChanged();
    } catch (error) {
      setProblem(asConversationError(error).message);
    } finally {
      setBusy(false);
    }
  }

  if (showing) {
    return (
      <div className="rounded-panel bg-surface-2 ring-line flex w-[320px] flex-col gap-2 p-2 ring-1">
        {state.kind === "video" ? (
          <video src={showing} controls autoPlay className="w-full rounded-[10px]" />
        ) : (
          <img src={showing} alt={`${noun}, opened once`} className="w-full rounded-[10px]" />
        )}
        <span className="text-text-lo text-[11px]">
          Closing this ends it — the key is already gone from this device.
        </span>
      </div>
    );
  }

  const spent = !state.openable;
  return (
    <div
      className={cn(
        "rounded-panel ring-line flex w-[260px] flex-col gap-1.5 p-3 ring-1",
        spent ? "bg-surface-2" : "bg-surface-3",
      )}
    >
      <span className="flex items-center gap-2">
        <Icon
          name={spent ? "lock" : state.kind === "video" ? "play" : "image"}
          size={15}
          className={spent ? "text-text-lo shrink-0" : "text-accent-soft shrink-0"}
        />
        <span className="text-text-hi text-[12px] font-medium">
          {noun}
          {spent ? "" : " · once"}
        </span>
      </span>

      {spent ? (
        <span className="text-text-lo text-[11px]">
          {state.outgoing
            ? "Sent. You can open your own copy of the file, not this."
            : "Opened. The key was destroyed, so this cannot be opened again."}
        </span>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => void open()}
            className="rounded-control bg-accent text-on-accent px-2.5 py-1.5 text-[12px] font-medium enabled:hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-fill-disabled disabled:text-text-disabled"
          >
            {busy ? "Opening…" : `Open ${noun.toLowerCase()}`}
          </button>
          <span className="text-text-lo text-[11px]">
            Once. Nexo cannot stop a screenshot.
          </span>
        </>
      )}
      {problem ? (
        <span className="text-[11px] text-[var(--danger)]">{problem}</span>
      ) : null}
    </div>
  );
}

function Bubble({
  row,
  index,
  conversation,
  onOpenMedia,
  onReply,
  onForward,
  onJumpTo,
  onChangedHere,
  onPinnedChange,
  onDeleteForMe,
  onReact,
  onRevise,
}: {
  row: Row;
  index: number;
  conversation: Conversation;
  onOpenMedia: (envelopeId: number) => void;
  onReply?: ((message: Message) => void) | undefined;
  onForward?: ((message: Message) => void) | undefined;
  onJumpTo: (envelopeId: number) => void;
  /** Opening a view-once changed the store; reload so every view agrees. */
  onChangedHere: () => void;
  onPinnedChange: (envelopeId: number, pinned: boolean) => void | Promise<void>;
  onReact: (target: string, emoji: string, on: boolean) => void | Promise<void>;
  onRevise: (target: string, body?: string) => void | Promise<void>;
  onDeleteForMe: (envelopeId: number) => void | Promise<void>;
}) {
  const { message, startsRun, endsRun } = row;
  const account = useApp((s) => s.account);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  // Widens the column below. Computed once here rather than asked twice.
  const hasMedia = !!message.attachments?.some((a) => isPlayable(a.kind));

  // Read at the moment the menu is built, from the message's own send time --
  // never frozen when the conversation opened. A menu opened at 9:58 must stop
  // offering these two minutes later, not stay valid for ever.
  const withinWindow = Date.now() - message.at.getTime() <= EDIT_WINDOW_MS;

  async function askToRetract() {
    // The wording is the feature. "Deleted for everyone" is a claim this
    // cannot make; what actually happens is a request that well-behaved
    // clients honour.
    const ok = await confirm(
      "Delete for everyone",
      "This asks every Nexo app that has this message to remove it. Copies on a modified app can remain.",
    );
    if (ok && message.clientId) await onRevise(message.clientId, undefined);
  }
  // `useConversations` marks our own messages "me"; everything else is a
  // sender device id. There is no profile directory yet (M7), so an incoming
  // message is named from the conversation when that is unambiguous -- a DM
  // has exactly one other party -- and left unnamed in a group rather than
  // attributed to a guess.
  const mine = message.authorId === "me";
  const authorName = mine
    ? (account?.display_name ?? "You")
    : conversation.kind === "dm"
      ? conversation.title
      : "Unknown sender";
  const authorSeed = mine ? (account?.handle ?? "me") : message.authorId;

  const { onContextMenu, menu } = useContextMenu(() =>
    messageMenuItems(
      {
        hasBody: !!message.body,
        mine,
        clientId: message.clientId,
        retracted: !!message.retracted,
        withinWindow,
        queued: message.state === "sending",
        pinned: !!message.pinned,
      },
      {
        reply: () => onReply?.(message),
        copy: () => void copyText(message.body),
        forward: () => onForward?.(message),
        edit: () => setEditing(message.body),
        react: () => setPicking(true),
        togglePin: () => void onPinnedChange(Number(message.id), !message.pinned),
        deleteForMe: () => void onDeleteForMe(Number(message.id)),
        deleteForEveryone: () => void askToRetract(),
      },
    ),
  );
  // The peer's *handle*, which is not the conversation's title.
  //
  // This used to read `conversation.title`, and a title is a label: for a DM
  // whose member list has not been filled in it is the literal string
  // "Unnamed conversation", which `HandleAvatar` then looked up as an account.
  // Every visit to Messages or Home sent `profile("unnamed conversation")` to
  // the server and took a 404 for it. It is the same conflation the core's
  // `list_conversations` already records fixing once for groups -- "looked up
  // a group's title as if it were somebody's handle" -- which survived here
  // for the untitled DM. `peerHandle` reads the member list, and answers
  // `undefined` rather than guessing when there is nobody to name.
  const authorHandle = mine
    ? (account?.handle ?? "")
    : (peerHandle(conversation, account?.handle) ?? "");
  const showReceipts = useApp((s) => s.preferences.readReceipts);

  return (
    <div
      className={cn(
        "message-in flex w-full items-end gap-2",
        mine ? "flex-row-reverse" : "flex-row",
        startsRun ? "mt-3 first:mt-0" : "mt-0.5",
      )}
      style={{ "--stagger": `${Math.min(index, 10) * 30}ms` } as CSSProperties}
      onContextMenu={onContextMenu}
      // Double-click replies, the way every desktop messenger does it. The
      // menu still offers it; this is the shortcut for the one entry people
      // reach for most.
      onDoubleClick={() => onReply?.(message)}
      // What a quote scrolls to. A queued message has a negative id, which is
      // fine: it is unique, and nothing can be replying to it yet anyway.
      data-envelope-id={message.id}
    >
      {menu}
      <span className="w-8 shrink-0">
        {endsRun ? (
          authorHandle ? (
            <HandleAvatar handle={authorHandle} name={authorName} size={32} />
          ) : (
            <Avatar seed={authorSeed} name={authorName} size={32} />
          )
        ) : null}
      </span>

      {/* The column shrinks to its content: a two-word reply is a two-word
          bubble, not a bubble stretched to the width of the column.

          Media gets a wider ceiling than text, and that is not a nicety. The
          measure that makes a paragraph readable is the one that makes a
          photograph a thumbnail; 64% of a column that is itself beside a
          context panel left pictures at a size you had to open to see. Text
          keeps its measure, pictures get room, and a caption under a picture
          reads fine at the wider one. */}
      <div
        className={cn(
          "flex flex-col gap-1",
          hasMedia ? "max-w-[min(560px,80%)]" : "max-w-[min(520px,64%)]",
          mine ? "items-end" : "items-start",
        )}
      >
        {startsRun && !mine ? (
          <span className="text-text-mid px-1 text-[11px] font-medium">
            {authorName}
          </span>
        ) : null}

        {message.undecryptable ? (
          <UndecryptableBubble />
        ) : message.unsupported ? (
          <UnsupportedBubble />
        ) : (
          <>
            {message.attachments
              ?.filter((a) => isPlayable(a.kind))
              .map((attachment) => (
                <AttachedMedia
                  key={attachment.id}
                  attachment={attachment}
                  onOpen={onOpenMedia}
                />
              ))}

            <LinkPreviewCard message={message} />

            {/*
              Above the bubble rather than inside it: the quote is context for
              the answer, not part of what was said. A retracted reply loses its
              quote too -- what it was answering stops mattering once the answer
              is gone.
            */}
            {message.replyTo && !message.retracted ? (
              <QuoteBlock quote={message.replyTo} mine={mine} onJumpTo={onJumpTo} />
            ) : null}
            {/* Said before the words, because it changes how they should be
                read. The name is the forwarder's claim -- nobody else was
                there and nothing can check it -- so when there is no name the
                line says only that it was passed on, rather than guessing. */}
            {message.forwarded ? (
              <p
                className={cn(
                  "mb-1 flex items-center gap-1 text-[11px] italic",
                  mine ? "text-on-accent/70" : "text-text-lo",
                )}
              >
                <Icon name="send" size={10} />
                {message.forwardedFrom
                  ? `Forwarded from ${message.forwardedFrom}`
                  : "Forwarded"}
              </p>
            ) : null}
            {message.sticker ? (
              <StickerBubble sticker={message.sticker} />
            ) : message.viewOnce ? (
              <ViewOnceBubble message={message} onOpenChanged={onChangedHere} />
            ) : message.retracted ? (
              // The row is still here on purpose. Removing it would close the
              // gap where something used to be, which is not what being taken
              // back looks like to the people who saw it.
              <div className="rounded-bubble border-line text-text-lo border border-dashed px-3.5 py-2 text-message italic">
                {mine ? "You took this back" : "This message was taken back"}
              </div>
            ) : editing !== null ? (
              <div className="rounded-bubble bg-surface-3 border-line flex flex-col gap-2 border p-2">
                <textarea
                  rows={3}
                  value={editing}
                  autoFocus
                  onChange={(event) => setEditing(event.target.value)}
                  aria-label="Edit this message"
                  className="text-text-hi rounded-control bg-surface-2 resize-none px-2 py-1.5 text-message outline-none focus-visible:ring-1 focus-visible:ring-accent"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-accent-soft text-meta hover:underline"
                    onClick={() => {
                      const next = editing.trim();
                      // An empty edit is a retraction wearing a disguise, and
                      // it should be the deliberate one instead.
                      if (next && message.clientId) {
                        void onRevise(message.clientId, next);
                      }
                      setEditing(null);
                    }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="text-text-lo text-meta hover:underline"
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : message.body ? (
              <div
                className={cn(
                  "rounded-bubble px-3.5 py-2 text-message leading-6 whitespace-pre-wrap",
                  mine
                    ? "bg-accent text-on-accent"
                    : "bg-surface-3 text-text-hi border border-line",
                  // The corner nearest the sender squares off inside a run, so
                  // a run reads as one block rather than a stack of pills.
                  !startsRun && (mine ? "rounded-tr-md" : "rounded-tl-md"),
                  !endsRun && (mine ? "rounded-br-md" : "rounded-bl-md"),
                )}
              >
                {message.body}
              </div>
            ) : null}

            {message.attachments
              ?.filter((a) => a.kind === "file")
              .map((attachment) => (
                <FileRow key={attachment.id} attachment={attachment} />
              ))}
          </>
        )}

        {/* The feed's pills, in a conversation. Same shape, same aria — the
            component was written once and the reaction data was given the same
            shape on purpose. */}
        {message.reactions && message.reactions.length > 0 ? (
          <div
            className={cn(
              "flex flex-wrap gap-1",
              mine ? "justify-end" : "justify-start",
            )}
          >
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                aria-label={`${reaction.count} reacted ${reaction.emoji}`}
                aria-pressed={reaction.mine}
                onClick={() =>
                  message.clientId &&
                  void onReact(message.clientId, reaction.emoji, !reaction.mine)
                }
                className={cn(
                  "rounded-full px-2 py-0.5 text-meta transition-colors duration-[var(--motion-fast)]",
                  reaction.mine
                    ? "bg-accent/18 text-accent-soft"
                    : "text-text-mid bg-fill-hover hover:bg-fill-active",
                )}
              >
                {/* User content, not chrome: somebody chose this. */}
                <span aria-hidden="true">{reaction.emoji}</span>{" "}
                <span className="font-mono text-[11px]">{reaction.count}</span>
              </button>
            ))}
          </div>
        ) : null}

        {picking && message.clientId ? (
          <div className="rounded-panel bg-surface-2 ring-line-strong z-[300] overflow-hidden ring-1">
            {/* Closed after one: a reaction is a single choice, unlike the
                composer where two in a row is normal. */}
            <EmojiPicker
              onPick={(emoji) => {
                if (message.clientId)
                  void onReact(message.clientId, emoji, true);
                setPicking(false);
              }}
            />
          </div>
        ) : null}

        {endsRun ? (
          <span
            className={cn(
              "text-text-lo flex items-center gap-1.5 px-1 text-[11px]",
              mine && "flex-row-reverse",
            )}
          >
            {clockTime(message.at)}
            {/* A quiet mark, and nothing that claims the original is gone --
                it is, from this device's point of view, and saying more than
                that would be a promise about other people's copies. */}
            {message.edited && !message.retracted ? (
              <span title="Edited by the sender">edited</span>
            ) : null}
            {mine && showReceipts ? (
              <DeliveryTick state={message.state} />
            ) : null}
            {message.state === "sending" && !showReceipts ? (
              <Icon name="clock" size={12} aria-label="Sending" />
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Rule 7: fail closed. A message that will not decrypt says so, in place,
 * permanently. There is no plaintext fallback, and skipping it silently would
 * hide exactly the event a user needs to know about.
 */
/**
 * A message that decrypted but whose shape this build does not know.
 *
 * Deliberately not the danger treatment of `UndecryptableBubble`: nothing
 * failed and nothing is lost. Somebody is running a newer Nexo, the bytes are
 * in the store, and the remedy is an update rather than asking them to resend.
 *
 * The kind is not shown. It is an internal name -- "reaction", "story" -- and
 * putting it in front of someone would be leaking the wire format into prose
 * to no purpose.
 */
function UnsupportedBubble() {
  return (
    <div className="rounded-bubble border-line bg-surface-3 flex items-start gap-2.5 border px-3.5 py-2.5">
      <Icon name="refresh" size={16} className="text-text-lo mt-0.5 shrink-0" />
      <span className="text-meta leading-relaxed">
        <span className="text-text-hi block font-medium">
          This message needs a newer version of Nexo
        </span>
        <span className="text-text-mid">
          It arrived safely and is kept on this device. Updating will show it.
        </span>
      </span>
    </div>
  );
}

function UndecryptableBubble() {
  return (
    <div className="rounded-bubble border-danger/35 bg-danger/8 flex items-start gap-2.5 border px-3.5 py-2.5">
      <Icon name="lock" size={16} className="text-danger mt-0.5 shrink-0" />
      <span className="text-meta leading-relaxed">
        <span className="text-danger block font-medium">
          Can't decrypt this message
        </span>
        <span className="text-text-mid">
          It was sent in an epoch this device has no key for. Ask the sender to
          send it again.
        </span>
      </span>
    </div>
  );
}

/**
 * One attachment the app can play or draw, decrypted.
 *
 * The envelope id is all the WebView gets; Rust downloads the ciphertext,
 * decrypts it, verifies the tag and the digest, sniffs the *bytes* to decide
 * what it really is, and only then hands back a `data:` URL — the CSP allows
 * no remote host of any kind, so inline is the only route there is.
 *
 * One component for four shapes rather than four components, because the part
 * that is actually difficult is the same in all of them: fetch once, survive
 * being unmounted mid-fetch, and show something honest while there is nothing
 * to show. What differs is the element at the end.
 */
function AttachedMedia({
  attachment,
  onOpen,
}: {
  attachment: Attachment;
  onOpen: (envelopeId: number) => void;
}) {
  // A streamable attachment needs no fetch at all: the player is pointed at a
  // URL that is answered range by range, so the first frame and the duration
  // appear without the file moving. Everything else takes the old path, which
  // pulls the whole thing across IPC as a data URL and is capped because of it.
  const streaming = attachment.streamable
    ? streamUrl(Number(attachment.id))
    : null;

  const [url, setUrl] = useState<string | null>(streaming);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (streaming) {
      setUrl(streaming);
      setFailed(null);
      return;
    }
    let cancelled = false;
    setUrl(null);
    setFailed(null);
    void attachmentDataUrl(Number(attachment.id))
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch((error) => {
        // Rule 7: said, not swallowed, and not as a broken-image glyph either.
        // A file too large to inline is the common case and has a real answer
        // -- save it -- so the row below says so and stays usable.
        if (!cancelled) setFailed(asConversationError(error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, streaming]);

  const viewable = attachment.kind === "image" || attachment.kind === "video";
  const { onContextMenu, menu } = useContextMenu(() => [
    ...(viewable
      ? [
          {
            label: "View",
            icon: "eye" as const,
            onSelect: () => onOpen(Number(attachment.id)),
          },
        ]
      : []),
    {
      label: "Save as…",
      icon: "download" as const,
      onSelect: () => void saveTo(attachment),
    },
  ]);

  // Nothing to play and a reason why. The file row is the working answer for
  // it: it can still be saved and opened in something that can hold it.
  if (failed) {
    return (
      <div className="flex flex-col gap-1">
        <FileRow attachment={attachment} />
        <span className="text-text-lo px-1 text-[11px]">{failed}</span>
      </div>
    );
  }

  if (attachment.kind === "image") {
    return (
      <>
        {menu}
        <button
          type="button"
          onClick={() => onOpen(Number(attachment.id))}
          onContextMenu={onContextMenu}
          aria-label={`Open ${attachment.name}`}
          title={attachment.name}
          className="rounded-panel overflow-hidden bg-surface-3"
        >
          {url ? (
            // An <img>, not a background. The element used to be a div with a
            // background image inside a forced 4:3 box, which meant every
            // picture that was not 4:3 -- most of them, phones being what they
            // are -- was letterboxed into a corner of a box sized for
            // something else. The browser knows the real ratio; letting it use
            // it is what makes a picture arrive at the size it was sent at.
            <img
              src={url}
              alt={attachment.name}
              className="max-h-[440px] w-auto max-w-full cursor-zoom-in object-contain"
            />
          ) : (
            // The generated field, while there is nothing yet. A message that
            // carried a picture should hold the space it is going to need.
            <span
              className="block aspect-[4/3] w-[280px]"
              style={{ background: fieldFor(attachment.id) }}
            />
          )}
        </button>
      </>
    );
  }

  if (attachment.kind === "video") {
    return (
      <>
        {menu}
        <div
          onContextMenu={onContextMenu}
          className="rounded-panel overflow-hidden bg-surface-3"
        >
          {url ? (
            // `controls` and nothing else: no autoplay, because a conversation
            // that starts talking when you scroll past it is the thing people
            // turn media off to avoid.
            //
            // `preload="metadata"` now means what it says. Against a `data:`
            // URL it could not: the whole file was already in the page by the
            // time the element saw it. Against the streaming URL the element
            // asks for the header, draws the first frame, learns the duration,
            // and stops -- which is why a video no longer has to be fetched
            // before it can be looked at.
            <video
              src={url}
              controls
              preload="metadata"
              className="max-h-[440px] w-full max-w-full"
              aria-label={attachment.name}
            />
          ) : (
            <span
              className="block aspect-video w-[320px]"
              style={{ background: fieldFor(attachment.id) }}
            />
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {menu}
      <SoundRow
        attachment={attachment}
        url={url}
        onContextMenu={onContextMenu}
      />
    </>
  );
}

/**
 * Sound, in one of two dresses.
 *
 * A voice message is round, narrow and named for what it is, because that is
 * what people expect one to look like and because its name -- `recording.wav`,
 * or worse -- says nothing worth reading. A track keeps its file name above the
 * player, because with music the name *is* the content.
 *
 * Both use the browser's own controls. A custom scrubber would mean owning
 * seeking, buffering and keyboard access to save one row of chrome, and the
 * native one is already reachable by keyboard and already speaks the platform's
 * language for "play".
 */
function SoundRow({
  attachment,
  url,
  onContextMenu,
}: {
  attachment: Attachment;
  url: string | null;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const voice = attachment.kind === "voice";
  return (
    <div
      onContextMenu={onContextMenu}
      className={cn(
        "bg-surface-2 ring-line flex flex-col gap-1.5 p-2.5 ring-1",
        voice ? "rounded-bubble w-[320px]" : "rounded-panel w-[340px]",
      )}
    >
      <span className="flex items-center gap-2">
        <Icon
          name={voice ? "mic" : "music"}
          size={14}
          className="text-accent-soft shrink-0"
        />
        {/*
          A recording carries its own waveform, so the row shows that instead of
          a file name it was never given one worth reading -- `voice-1725…webm`
          tells nobody anything. A sound file somebody attached keeps its name,
          because they chose it.
        */}
        {attachment.voice ? (
          <>
            <Waveform peaks={attachment.voice.peaks} className="min-w-0 flex-1" />
            <span className="text-text-lo shrink-0 font-mono text-[11px] tabular-nums">
              {formatDuration(attachment.voice.durationMs)}
            </span>
          </>
        ) : (
          <>
            <span className="text-text-hi min-w-0 flex-1 truncate text-[12px]">
              {voice ? "Voice message" : attachment.name}
            </span>
            <span className="text-text-lo shrink-0 font-mono text-[11px]">
              {fileSize(attachment.size)}
            </span>
          </>
        )}
      </span>
      {url ? (
        <audio
          src={url}
          controls
          preload="metadata"
          className="h-8 w-full"
          aria-label={voice ? `Voice message, ${attachment.name}` : attachment.name}
        />
      ) : (
        // Held at the height the player will take, so the bubble does not jump
        // under the cursor the moment the bytes arrive.
        <span className="text-text-lo flex h-8 items-center text-[11px]">
          Decrypting…
        </span>
      )}
    </div>
  );
}

/** Downloads, decrypts and writes one attachment where the user chooses. */
async function saveTo(attachment: Attachment): Promise<void> {
  const path = await pickSavePath(attachment.name);
  if (!path) return;
  try {
    await saveAttachmentTo(Number(attachment.id), path);
    await notify("Saved", `${attachment.name} was saved.`);
  } catch (error) {
    await notify("Couldn't save that", asConversationError(error).message);
  }
}

/**
 * One attached file.
 *
 * `attachment.id` is the envelope id: that is all the WebView needs to ask for
 * the file, and all it is given. The S3 key and the AES key stay in Rust
 * (rule 2), which downloads, decrypts, verifies, and only then writes to the
 * path the user chose.
 */
function FileRow({ attachment }: { attachment: Attachment }) {
  const [busy, setBusy] = useState(false);

  const save = async () => {
    // The name is a suggestion for the dialog. The user picks where it goes,
    // so a sender cannot choose a destination.
    const path = await pickSavePath(attachment.name);
    if (!path) return;
    setBusy(true);
    try {
      await saveAttachmentTo(Number(attachment.id), path);
    } catch (error) {
      // Rule 7: a file that failed to decrypt or failed to download says so.
      // Nothing partial is written -- Rust verifies before it writes -- and a
      // silent no-op here would look exactly like success.
      await notify(
        "Couldn't save that file",
        asConversationError(error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-panel bg-surface-3 flex items-center gap-3 border border-line px-3 py-2.5">
      <span
        className="text-text-hi flex size-9 shrink-0 items-center justify-center rounded-control font-mono text-[9px] font-semibold"
        style={{ background: fileTone(attachment.name).tint }}
        aria-hidden="true"
      >
        {fileTone(attachment.name).label}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-text-hi block truncate text-meta font-medium">
          {attachment.name}
        </span>
        <span className="text-text-lo block font-mono text-[11px]">
          {busy ? "Decrypting\u2026" : fileSize(attachment.size)}
        </span>
      </span>
      <IconButton
        name="download"
        label={`Save ${attachment.name}`}
        size={16}
        disabled={busy}
        onClick={() => void save()}
      />
    </div>
  );
}

/**
 * §4.5: previews are fetched by this machine and are off by default, because
 * a server-side fetcher is a request-forgery and a metadata leak. With the
 * setting off, a link stays a link — and nothing is fetched at all, which is
 * the part of the promise that matters.
 *
 * The card is drawn only once a preview has actually come back. No skeleton:
 * a placeholder for something that may never arrive (an unreachable host, a
 * page with no title, a link Rust refuses) would leave a hole in the
 * conversation, and the link underneath it is already the honest fallback.
 *
 * No image is fetched. The band is generated from the URL, so the preview
 * costs exactly one request to whoever owns the link, not two.
 */
/**
 * Hands a link to the OS browser instead of following it here.
 *
 * A bare `href` navigates the WebView itself: the app is replaced by the page,
 * and there is no back button in a frameless window to come back with — the
 * only way out is quitting. The `href` stays for the hover target and the
 * accessibility tree; the click never uses it.
 */
function openExternally(url: string) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openUrl(url);
  };
}

function LinkPreviewCard({ message }: { message: Message }) {
  const fetched = useLinkPreview(message.body);
  // Mock fixtures carry their own preview; live messages get theirs from the
  // hook. Both render the same way.
  const preview = message.preview ?? fetched;
  const url = preview?.url ?? firstLink(message.body);

  // Built before the early return: hooks cannot be called conditionally, and
  // an empty address simply yields an empty menu, which opens nothing.
  const { onContextMenu, menu } = useContextMenu(() =>
    url
      ? [
          {
            label: "Open link",
            icon: "external",
            onSelect: () => void openUrl(url),
          },
          {
            label: "Copy address",
            icon: "link",
            onSelect: () => void copyText(url),
          },
        ]
      : [],
  );

  if (!url) return null;

  if (!preview) {
    return (
      <>
        {menu}
        <a
          href={url}
          onClick={openExternally(url)}
          onContextMenu={onContextMenu}
          className="text-accent-soft inline-flex items-center gap-1.5 text-meta underline decoration-line-strong underline-offset-2"
        >
          <Icon name="link" size={14} />
          {url}
        </a>
      </>
    );
  }

  return (
    <>
      {menu}
      <a
        href={preview.url}
        onClick={openExternally(preview.url)}
        onContextMenu={onContextMenu}
        className="rounded-panel bg-surface-3/70 block w-full max-w-[360px] border border-line p-2.5"
      >
        <span className="text-accent-soft block truncate text-[11px] underline decoration-line-strong underline-offset-2">
          {preview.url}
        </span>
        <span className="text-accent-soft mt-2 block text-[11px] font-medium">
          {preview.source}
        </span>
        <span className="text-text-hi block text-meta font-medium">
          {preview.title}
        </span>
        {preview.description ? (
          <span className="text-text-mid mt-0.5 block text-[11px] leading-relaxed">
            {preview.description}
          </span>
        ) : null}
        <span
          className="rounded-control mt-2.5 block h-32 w-full"
          style={{ background: fieldFor(preview.url) }}
          aria-hidden="true"
        />
      </a>
    </>
  );
}
