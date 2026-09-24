import { useEffect, useState } from "react";

import { useApp } from "../../app/store";
import type { Message } from "../../lib/types";
import { pickFile } from "../../lib/native";
import { useConversations } from "../../app/useConversations";
import { cn } from "../../lib/cn";
import { ConversationAvatar } from "../../components/ui/ConversationAvatar";
import { Button, IconButton } from "../../components/ui/Button";
import { Field } from "../../components/ui/Controls";
import { EmptyState } from "../../components/ui/Feedback";
import { Icon } from "../../components/ui/Icon";
import { Panel } from "../../components/ui/Surface";
import { Composer } from "../messages/Composer";
import { ConversationRow } from "../messages/ConversationList";
import { MessageList } from "../messages/MessageList";
import { peerHandle } from "../messages/peer";
import { MIN_HOME_CHAT } from "./Splitter";

/**
 * A conversation beside the feed.
 *
 * The feed column is 660px wide and the window is usually much wider, so
 * without this the right-hand margin was empty. Filling it with the
 * conversation you were last in is the one thing that is almost always what
 * you want next — reading the feed and answering someone are the two things
 * people do in the same sitting.
 *
 * # Which conversation
 *
 * By default the most recent one. `conversations` arrives sorted by last
 * activity (the server-side list is ordered by `last_message_at_ms`), so the
 * first one is the answer, and there is no separate "last opened" to track:
 * the conversation you last *wrote in* is a better guess than the one you last
 * clicked on, and it is already known.
 *
 * The header is also a picker, because the default is a guess and a guess that
 * cannot be overruled is just a limitation. Choosing one suspends the
 * following until it is taken back — the staleness the paragraph above warns
 * about is the **silent** kind, and a choice somebody made is not that.
 *
 * The choice does not survive a restart, deliberately. It answers "not that
 * one, this one, right now"; a conversation that sat here for a week while
 * everything happened elsewhere would be the silent staleness again, arrived
 * at by a different route.
 *
 * # Why the real components
 *
 * `MessageList` and `Composer` are the ones the Messages page uses, not
 * lookalikes. A second implementation would need its own copy of message
 * grouping, delivery states, the offline-queue "sending" mark and the
 * attachment rules — and would drift from the real one the first time either
 * changed. The panel is a narrower container around the same parts.
 *
 * # Width
 *
 * Given, not chosen, and given as a CSS length rather than a number: while the
 * splitter is being dragged the width is a custom property the splitter writes
 * directly, with no React render in the loop. Passing `var(--home-chat-w)`
 * keeps that arrangement visible at the call site instead of hiding it in a
 * variable name this file would have to know about.
 *
 * The floor and the ceiling are CSS too. What they guard against is the
 * *window* shrinking under a width that was perfectly legal when it was set,
 * and CSS re-evaluates that during a window resize without being asked.
 */
/**
 * # The header is three controls, not one
 *
 * The picture, the name, and the way out. They used to be a single button that
 * opened the switcher, which made the avatar mean "switch conversation" —
 * everywhere else in this app somebody's picture is the way to their profile,
 * and a picture that means something different in one pane is worse than no
 * picture at all. The avatar goes to the profile; the name beside it, with its
 * chevron, is the switcher.
 *
 * Only in a DM. A group has no one person behind its picture, so there is
 * nowhere for it to lead and it is not a control at all — better than a button
 * that has to explain why it did nothing.
 *
 * Switching conversation, in the pane rather than over it.
 *
 * This was a dropdown menu, capped at eight entries because a menu does not
 * scroll and somebody with two hundred conversations would have got a list
 * taller than the screen. A panel that slides across the pane has no such
 * ceiling: it scrolls, it can be searched, and it shows the same rows the
 * Messages tab shows, so switching here looks like switching there.
 *
 * It covers the chat and nothing else. The feed keeps its width and its scroll
 * position -- the pane is the only thing that moves, which is the difference
 * between switching a conversation and navigating away from what you were
 * reading.
 */

export function HomeChat({ now, width }: { now: Date; width: string }) {
  const go = useApp((s) => s.go);
  const openConversation = useApp((s) => s.openConversation);
  const viewProfile = useApp((s) => s.viewProfile);
  const me = useApp((s) => s.account?.handle);
  const overrides = useApp((s) => s.conversationOverrides);

  // Two steps, because `useConversations` loads the history for an id it is
  // given and the id is only known once the list has arrived. The first pass
  // fetches the list with nothing selected; the effect then names one and the
  // second pass fills in its messages.
  const [shownId, setShownId] = useState<string | undefined>(undefined);
  // `undefined` means "follow whatever is most recent". A string means someone
  // chose that one and it stays until they choose otherwise.
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const live = useConversations(shownId);
  // Cleared when the shown conversation changes: this pane slides between
  // conversations, and a reply aimed at a message in one must not follow you
  // into another where its target does not exist.
  const [replyingTo, setReplyingTo] = useState<Message | undefined>(undefined);
  useEffect(() => setReplyingTo(undefined), [shownId]);
  const newest = live.conversations[0];
  const following = chosenId === undefined;

  useEffect(() => {
    // A chosen conversation that has been removed from this device stops being
    // a choice. Falling back to following beats an empty panel beside a feed
    // that is plainly not empty.
    if (
      chosenId &&
      live.conversations.length > 0 &&
      !live.conversations.some((c) => c.id === chosenId)
    ) {
      setChosenId(undefined);
      return;
    }
    const want = chosenId ?? newest?.id;
    if (want && want !== shownId) setShownId(want);
  }, [chosenId, newest, shownId, live.conversations]);

  // The fallback covers one frame: the list arrives before the effect below
  // has named anything, and without it the panel would flash "no conversations
  // yet" beside a feed that plainly has some.
  const conversation =
    live.conversations.find((c) => c.id === shownId) ?? newest;

  const openInMessages = () => {
    if (!conversation) return;
    openConversation(conversation.id);
    go("messages");
  };

  // `undefined` for a group, and for a DM whose member list has not arrived
  // yet — see `peerHandle`. Both mean the picture is not a way anywhere.
  const peer = conversation ? peerHandle(conversation, me) : undefined;

  // Drawn the same whether or not it leads anywhere; only the wrapper differs.
  const avatar = conversation ? (
    <ConversationAvatar
      conversationId={conversation.id}
      kind={conversation.kind}
      title={conversation.title}
      hasAvatar={conversation.hasAvatar ?? false}
      version={conversation.avatarVersion}
      size={30}
    />
  ) : null;

  // Open, and what is typed into its search box. The query is cleared on
  // close so it does not greet you next time with a list filtered by
  // something you were looking for yesterday.
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  const closePicker = () => {
    setPicking(false);
    setQuery("");
  };

  // Escape closes it, the way it closes every other layer in the app. Bound
  // while it is open and not otherwise, so Escape means something else --
  // anything else -- the rest of the time.
  useEffect(() => {
    if (!picking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPicking(false);
      setQuery("");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [picking]);

  // Matched on the name only. The Messages tab also searches message bodies
  // through the store's index, and that is the right thing there -- here it
  // would put results in a list whose rows are conversations, which is a
  // different answer to a different question.
  const term = query.trim().toLowerCase();
  const listed = term
    ? live.conversations.filter((c) => c.title.toLowerCase().includes(term))
    : live.conversations;

  return (
    <Panel
      tone="list"
      // `relative` and `overflow-hidden` are what make the switcher slide
      // *inside* the pane instead of over the window: it is positioned against
      // this box and clipped by it, so the feed beside it never moves.
      className="relative flex shrink-0 flex-col overflow-hidden"
      style={{ width, minWidth: MIN_HOME_CHAT, maxWidth: "58%" }}
      aria-label="Conversation beside the feed"
    >
      {conversation ? (
        <>
          <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-3 py-2.5">
            {/* `flex`, so the button is exactly the circle it wraps: a
                button is inline-block by default and its height comes from
                the line box, which leaves a few pixels of descender under a
                30px avatar and puts the focus ring around a shape that is
                not the picture. */}
            {peer ? (
              <button
                type="button"
                aria-label={`Open ${conversation.title}'s profile`}
                onClick={() => viewProfile(peer)}
                className="focus-visible:ring-accent flex rounded-full outline-none transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-state)] hover:opacity-80 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-1)]"
              >
                {avatar}
              </button>
            ) : (
              avatar
            )}
            <button
              type="button"
              aria-expanded={picking}
              aria-label={`Switch conversation, currently ${conversation.title}`}
              onClick={() => setPicking(true)}
              className="rounded-control flex min-w-0 flex-1 items-center gap-2 px-1.5 py-0.5 text-left outline-none transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)] hover:bg-fill-hover focus-visible:ring-1 focus-visible:ring-accent"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-text-hi truncate text-body font-medium">
                  {conversation.title}
                </span>
                <span className="text-text-lo text-[11px]">
                  {following ? "Most recent" : "Chosen"}
                </span>
              </span>
              {/* Points down, at the panel it pulls in. The rotation is the
                  same trick the rest of the app uses -- there is one chevron
                  in the set and every direction is an angle on it. */}
              <Icon
                name="chevronLeft"
                size={13}
                className="text-text-lo shrink-0 -rotate-90"
              />
            </button>
            <IconButton
              name="external"
              label="Open in Messages"
              size={16}
              onClick={openInMessages}
            />
          </div>

          <MessageList
            messages={live.messages}
            now={now}
            conversation={{ ...conversation, ...overrides[conversation.id] }}
            onChanged={() => void live.refresh()}
            onReply={setReplyingTo}
          />

          <Composer
            conversationId={conversation.id}
            conversationTitle={conversation.title}
            onSend={(body, attachment) => {
              if (attachment)
                void live.sendFile(attachment, body || undefined);
              else if (replyingTo?.clientId) {
                void live.sendReply(body, replyingTo.clientId);
                setReplyingTo(undefined);
              } else void live.send(body);
            }}
            onSendVoice={(recording) => void live.sendVoice(recording)}
            replyingTo={
              replyingTo
                ? {
                    excerpt: replyingTo.body,
                    outgoing: replyingTo.authorId === "me",
                  }
                : undefined
            }
            onCancelReply={() => setReplyingTo(undefined)}
            onSendSticker={(pack, stickerId) =>
              void live.sendSticker(pack, stickerId)
            }
            {...(conversation.kind === "dm"
              ? {
                  onSendViewOnce: () => {
                    void pickFile({ title: "Send once", media: true }).then(
                      (picked) => {
                        if (picked) void live.sendOnce(picked);
                      },
                    );
                  },
                }
              : {})}
          />
        </>
      ) : (
        // No conversations yet. The panel says so rather than sitting empty,
        // and sends you where starting one actually happens.
        <EmptyState
          icon="messages"
          title="No conversations yet"
          body="Once you are writing with someone, the most recent conversation appears here beside the feed."
          action={
            <Button onClick={() => go("messages")}>Go to Messages</Button>
          }
        />
      )}

      {/* Mounted whether or not it is open, because a panel that is only
          rendered while open cannot slide away -- it would vanish. `inert`
          is what keeps the closed one out of the tab order and away from a
          screen reader; without it there would be a whole conversation list
          sitting off-screen that Tab still walks into. */}
      <div
        inert={!picking}
        aria-label="Switch conversation"
        className={cn(
          "bg-surface-1 absolute inset-0 z-10 flex flex-col transition-transform duration-[var(--motion-panel)] ease-[var(--ease-out)]",
          picking ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2 border-b border-[var(--hairline)] px-3 py-2.5">
          <IconButton
            name="chevronLeft"
            label="Back to the conversation"
            size={16}
            onClick={closePicker}
          />
          <span className="text-text-hi flex-1 text-body font-medium">
            Conversations
          </span>
        </div>

        <div className="px-3 pt-3">
          <Field
            label="Search"
            hideLabel
            placeholder="Search conversations"
            value={query}
            // Focused on open, so typing a name works straight away -- which
            // is how somebody with many conversations gets to one of them
            // without scrolling. `key` remounts it when the panel opens,
            // because `autoFocus` only fires on mount.
            key={picking ? "open" : "closed"}
            autoFocus={picking}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2"
          role="listbox"
          aria-label="Conversations"
        >
          {/* Going back to following is a choice like any other, so it is a
              row in the list rather than a control somewhere else. */}
          <button
            type="button"
            role="option"
            aria-selected={following}
            onClick={() => {
              setChosenId(undefined);
              closePicker();
            }}
            className={cn(
              "rounded-panel flex w-full items-center gap-3 px-2.5 py-2.5 text-left transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
              following ? "bg-fill-hover" : "hover:bg-fill",
            )}
          >
            <span className="bg-surface-3 text-text-lo flex size-10 shrink-0 items-center justify-center rounded-full">
              <Icon name="clock" size={17} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-text-hi block truncate text-body font-medium">
                Most recent
              </span>
              <span className="text-text-lo block text-meta">
                Follows whoever wrote last
              </span>
            </span>
            {following ? (
              <Icon name="check" size={15} className="text-accent-soft shrink-0" />
            ) : null}
          </button>

          {listed.map((c, index) => (
            <ConversationRow
              key={c.id}
              conversation={{ ...c, ...overrides[c.id] }}
              last={undefined}
              now={now}
              active={c.id === shownId}
              selected={false}
              showPresence={false}
              index={index}
              bulk={null}
              onClick={() => {
                setChosenId(c.id);
                closePicker();
              }}
              onRemoved={() => void live.refresh()}
            />
          ))}

          {listed.length === 0 ? (
            <p className="text-text-lo px-2.5 py-6 text-center text-meta">
              {term
                ? `Nothing here matches “${query.trim()}”.`
                : "No conversations yet."}
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
