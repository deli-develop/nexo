import { useEffect, useMemo, useState } from "react";
import type { Recording } from "./useRecorder";
import { notify, pickFile } from "../../lib/native";
import { useApp } from "../../app/store";
import { useTyping } from "../../app/useTyping";
import type { LiveConversations } from "../../app/useConversations";
import { useLayout } from "../../app/useLayout";
import { searchable, useUserSearch } from "../../app/useUserSearch";
import type { Conversation, Message } from "../../lib/types";
import {
  acknowledgeKeyChange,
  asConversationError,
  forwardMessage,
  startConversation,
  startGroup,
} from "../../lib/conversations";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Controls";
import { Callout, EmptyState } from "../../components/ui/Feedback";
import { Icon } from "../../components/ui/Icon";
import { RemoteImage } from "../../components/ui/RemoteImage";
import { Panel } from "../../components/ui/Surface";
import { Composer } from "./Composer";
import { ContextPanel } from "./ContextPanel";
import { ConversationSearch } from "./ConversationSearch";
import { ForwardPicker } from "./ForwardPicker";
import { peerHandle } from "./peer";
import { ConversationList } from "./ConversationList";
import { MessageList } from "./MessageList";

/**
 * Messages (§7.3): list, chat, context panel.
 *
 * Three layouts, one per width in `useLayout`:
 *
 * - **Phone.** One pane at a time. The list is the screen; opening a
 *   conversation replaces it, and the header's back arrow returns. This is the
 *   part that is not a narrow desktop: the list used to slide *over* the chat
 *   as a drawer, which meant a phone always had a conversation underneath
 *   whether or not anyone had chosen one, and the empty state below could
 *   never be seen on the device that needed it most.
 * - **Tablet, 768px and up.** List and chat side by side.
 * - **Desktop, 1280px and up.** And the 280px context panel as well, which
 *   collapses below that and stays reachable from the header button.
 */
export function MessagesPage({
  now,
  live,
}: {
  now: Date;
  /** Mounted once by the shell and shared with the header — see `AppShell`. */
  live: LiveConversations;
}) {
  const activeId = useApp((s) => s.activeConversationId);
  const contextOpen = useApp((s) => s.contextPanelOpen);
  const toggleContext = useApp((s) => s.toggleContextPanel);
  // Open, not toggle: the banner's button means "show me the safety number",
  // and toggling would hide it for anyone who already had the panel open.
  const openContextPanel = () => {
    if (!contextOpen) toggleContext();
  };
  const open = useApp((s) => s.openConversation);
  const overrides = useApp((s) => s.conversationOverrides);
  const layout = useLayout();

  const [starting, setStarting] = useState(false);

  const base = live.conversations.find((c) => c.id === activeId);
  const conversation = base
    ? { ...base, ...overrides[base.id], safetyDigits: live.safety ?? "" }
    : undefined;
  const showContext = contextOpen && layout.canShowContext;

  // The last message per conversation, for the list rows. Only the active
  // conversation's history is loaded, so every other row falls back to the
  // preview the core already computed.
  const lastMessages = useMemo(() => {
    const map: Record<string, Message | undefined> = {};
    for (const c of live.conversations) {
      map[c.id] =
        c.id === activeId ? live.messages[live.messages.length - 1] : undefined;
    }
    return map;
  }, [live.conversations, live.messages, activeId]);

  const list = (
    <ConversationList
      now={now}
      conversations={live.conversations}
      lastMessages={lastMessages}
      onStart={() => setStarting(true)}
      onRemoved={() => void live.refresh()}
    />
  );

  // On a phone the list and the conversation are two screens, and which one is
  // showing is simply whether a conversation is open. No drawer, no scrim, and
  // no third piece of state to fall out of step with `activeConversationId`.
  const showList = layout.canShowList || (!conversation && !starting);
  const showChat = layout.canShowList || !showList;

  return (
    <div className="relative flex min-h-0 flex-1">
      {showList ? list : null}

      {!showChat ? null : starting ? (
        <StartConversation
          onCancel={() => setStarting(false)}
          onStarted={(id) => {
            setStarting(false);
            open(id);
            void live.refresh();
          }}
        />
      ) : conversation ? (
        <ChatPane
          conversation={conversation}
          messages={live.messages}
          problem={live.problem}
          now={now}
          onSend={live.send}
          onSendFile={live.sendFile}
          onSendVoice={live.sendVoice}
          onSendReply={live.sendReply}
          onSendOnce={live.sendOnce}
          onSendSticker={live.sendSticker}
          onCompare={openContextPanel}
          onChanged={() => void live.refresh()}
          onDismissKeyChange={async () => {
            await acknowledgeKeyChange(conversation.id);
            await live.refresh();
          }}
        />
      ) : (
        <Panel
          tone="content"
          edge={false}
          className="flex flex-1 items-center justify-center"
        >
          <EmptyState
            icon="messages"
            title={live.loading ? "Loading" : "No conversation selected"}
            body={
              live.loading
                ? "Reading your local history."
                : layout.canShowList
                  ? "Pick a conversation on the left, or start a new one."
                  : "Pick a conversation, or start a new one."
            }
          />
        </Panel>
      )}

      {showContext && conversation && !starting ? (
        <ContextPanel
          conversation={conversation}
          now={now}
          onRefresh={live.refresh}
          messages={live.messages}
        />
      ) : null}
    </div>
  );
}

/**
 * Starting a conversation: type, and pick from who turns up.
 *
 * It used to be a box you typed an exact handle into, blind — no phone number
 * is collected anywhere, so a handle was the only key, and getting one letter
 * wrong told you nothing until the conversation failed to start. Public
 * accounts are searchable now (wave 6 added the route), so the box filters as
 * it is typed and the names underneath are the answer.
 *
 * Typing a handle by hand still works, and has to: a **private** account is
 * absent from every search by design, and the server is what leaves it out, so
 * somebody who has been given a handle directly must still be able to use it.
 * The list is a convenience over the flow, not a gate in front of it.
 */
function StartConversation({
  onCancel,
  onStarted,
}: {
  onCancel: () => void;
  onStarted: (id: string) => void;
}) {
  const [handle, setHandle] = useState("");
  const [title, setTitle] = useState("");
  // Everyone added so far, in order. One handle is a DM; more is a group, and
  // the server decides which from the member count rather than from a toggle
  // the user has to understand.
  const [invited, setInvited] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = handle.trim().toLowerCase();
  const everyone =
    pending && !invited.includes(pending) ? [...invited, pending] : invited;
  const isGroup = everyone.length > 1;

  const search = useUserSearch(handle);
  // Somebody already added is not an answer to "who do you mean". Leaving them
  // in the list would offer an entry that does nothing when it is clicked.
  const suggestions = search.results.filter((r) => !invited.includes(r.handle));

  function add(who: string) {
    const one = who.trim().toLowerCase();
    if (!one || invited.includes(one)) return;
    setInvited((current) => [...current, one]);
    setHandle("");
    setError(null);
  }

  function addPending() {
    add(pending);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (everyone.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(
        everyone.length === 1
          ? await startConversation(everyone[0]!)
          : await startGroup(everyone, title.trim()),
      );
    } catch (raw) {
      const e = asConversationError(raw);
      setError(
        e.kind === "rejected"
          ? "One of those handles has no key package available. Everyone needs to have opened Nexo at least once."
          : e.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      tone="content"
      edge={false}
      className="flex flex-1 items-center justify-center p-8"
    >
      <form onSubmit={submit} className="w-full max-w-[340px]">
        <h2 className="text-text-hi font-display text-[19px] font-medium">
          {isGroup ? "Start a group" : "Start a conversation"}
        </h2>
        <p className="text-text-lo mt-1.5 text-meta">
          Start typing a name or a handle. Nexo collects no phone numbers, so a
          handle is the only key — and a private account never appears here, so
          one you were given can still be typed out in full. Add a second person
          to make it a group.
        </p>

        {invited.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {invited.map((who) => (
              <li key={who}>
                <button
                  type="button"
                  onClick={() => setInvited((c) => c.filter((h) => h !== who))}
                  className="rounded-control bg-fill text-text-hi hover:bg-fill-hover flex items-center gap-1.5 border border-line px-2 py-1 text-[11px]"
                  aria-label={`Remove ${who}`}
                >
                  @{who}
                  <Icon name="close" size={11} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <Field
          label="Handle"
          className="mt-4"
          value={handle}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="alice"
          onChange={(e) => setHandle(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            // Enter adds another rather than submitting, so building a group
            // never means accidentally starting a DM with the first name.
            if (e.key === "Enter" && pending) {
              e.preventDefault();
              addPending();
            }
          }}
        />

        {/* The answers, under the box, as it is typed. */}
        {searchable(handle) ? (
          <div className="mt-2">
            {suggestions.length > 0 ? (
              <ul
                className="rounded-control border-line max-h-[220px] overflow-y-auto border"
                aria-label="People matching what you typed"
              >
                {suggestions.map((person) => (
                  <li key={person.handle}>
                    <button
                      type="button"
                      onClick={() => add(person.handle)}
                      className="hover:bg-fill-hover flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]"
                    >
                      {person.avatar_key ? (
                        <RemoteImage
                          imageKey={person.avatar_key}
                          alt={person.display_name}
                          className="size-8 shrink-0 rounded-full"
                        />
                      ) : (
                        <Avatar
                          seed={person.handle}
                          name={person.display_name}
                          size={32}
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="text-text-hi block truncate text-meta font-medium">
                          {person.display_name}
                        </span>
                        <span className="text-text-lo block truncate text-[11px]">
                          @{person.handle}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : search.searching ? (
              <p className="text-text-lo text-[11px]">Looking…</p>
            ) : search.problem ? (
              <p className="text-text-lo text-[11px]">{search.problem}</p>
            ) : (
              // Nobody found is not nobody there. A private account is absent
              // from every search on purpose, and the server is what leaves it
              // out -- so the honest line says the handle still works.
              <p className="text-text-lo text-[11px]">
                Nobody public matches that. A private account will not show up
                here; type the whole handle and add it anyway.
              </p>
            )}
          </div>
        ) : null}

        {pending ? (
          <button
            type="button"
            onClick={addPending}
            className="text-accent-soft mt-2 text-[11px] underline decoration-line-strong underline-offset-2"
          >
            Add @{pending}
          </button>
        ) : null}

        {isGroup ? (
          <Field
            label="Group name"
            className="mt-3"
            value={title}
            placeholder="Weekend plans"
            onChange={(e) => setTitle(e.target.value)}
          />
        ) : null}

        {error ? (
          <Callout tone="danger" icon="alert" className="mt-3">
            {error}
          </Callout>
        ) : null}

        <div className="mt-4 flex gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={everyone.length === 0 || busy}
          >
            {busy
              ? "Starting…"
              : isGroup
                ? `Start group (${everyone.length})`
                : "Start"}
          </Button>
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function ChatPane({
  conversation,
  messages,
  problem,
  now,
  onSend,
  onSendFile,
  onSendVoice,
  onSendReply,
  onSendOnce,
  onSendSticker,
  onCompare,
  onDismissKeyChange,
  onChanged,
}: {
  conversation: Conversation;
  messages: Message[];
  problem: string | null;
  now: Date;
  onSend: (body: string) => Promise<void>;
  onSendFile: (
    file: { name: string; mime: string; bytes: Uint8Array },
    body?: string,
  ) => Promise<void>;
  onSendVoice: (recording: Recording) => Promise<void>;
  onSendReply: (body: string, target: string) => Promise<void>;
  onSendOnce: (file: { mime: string; bytes: Uint8Array }) => Promise<void>;
  onSendSticker: (pack: string, stickerId: string) => Promise<void>;
  /// Opens the details panel, where the safety number is.
  onCompare: () => void;
  /// Clears the warning without claiming anything was verified.
  onDismissKeyChange: () => Promise<void>;
  /// Pinning or a local delete changed the store; reload from it.
  onChanged: () => void;
}) {
  // Cleared when the conversation changes: a reply aimed at a message in one
  // thread must not survive into another, where its target does not exist.
  const [replyingTo, setReplyingTo] = useState<Message | undefined>(undefined);
  const conversationId = conversation.id;
  const typing = useTyping(conversationId);
  useEffect(() => setReplyingTo(undefined), [conversationId]);

  const [forwarding, setForwarding] = useState<Message | undefined>(undefined);
  const account = useApp((s) => s.account);
  const searchOpen = useApp((s) => s.conversationSearchOpen);
  const setConversationSearch = useApp((s) => s.setConversationSearch);

  // The picker restricts to what a view-once can be; Rust sniffs the bytes and
  // refuses anything else regardless, since a chosen extension proves nothing.
  async function pickAndSendOnce() {
    // `media` is the existing "pictures and video" filter -- the same one
    // stories use. The bytes are sniffed before they are sent regardless: a
    // chosen extension proves nothing.
    const picked = await pickFile({ title: "Send once", media: true });
    if (picked) await onSendOnce(picked);
  }

  return (
    <Panel tone="content" edge={false} className="flex min-w-0 flex-1 flex-col">
      {/* Not dismissable by ignoring it, and not by restarting: the flag lives
          in the encrypted store, so closing the window does not clear it.
          THREAT-MODEL 4 names a key-substituting server as the adversary safety
          numbers exist to catch, and this is the only moment a user is told
          there is something to compare. */}
      {conversation.keyChanged ? (
        <Callout tone="danger" icon="alert" className="mx-3 mt-3">
          <p className="font-medium">The safety number here has changed.</p>
          <p className="mt-1 leading-relaxed">
            Somebody in this conversation is using a new key. That happens when
            they reinstall Nexo or move to another machine — and it is also what
            an attacker substituting a key would look like. Nexo cannot tell
            those apart. Compare the safety number with them before sending
            anything you would not want a stranger to read.
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button variant="primary" onClick={onCompare}>
              Compare safety numbers
            </Button>
            <Button onClick={() => void onDismissKeyChange()}>Dismiss</Button>
          </div>
        </Callout>
      ) : null}

      {problem ? (
        <Callout tone="warning" icon="alert" className="mx-3 mt-3">
          {problem}
        </Callout>
      ) : null}

      {/* N5: in an empty conversation the composer sits with the invitation
          rather than pinned to the bottom of an empty page. There is nothing
          above it to anchor to yet, and a lone box at the foot of a blank
          panel reads as the end of something instead of the start. It moves
          to its usual place as soon as there is a history to sit under. */}
      {messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4">
          <EmptyState
            icon="messages"
            title={`Say something to ${conversation.title}`}
            body="Messages here are end-to-end encrypted. Only the people in this conversation can read them."
          />
          <div className="w-full max-w-[560px]">
            <Composer
              onSend={(body, attachment) => {
                if (attachment) void onSendFile(attachment, body);
                else void onSend(body);
              }}
              onSendVoice={(recording) => void onSendVoice(recording)}
              conversationId={conversation.id}
            conversationTitle={conversation.title}
            />
          </div>
        </div>
      ) : (
        <>
          {/* Above the list, where a find bar belongs: it narrows what is
              below it rather than floating over it. */}
          {forwarding ? (
            <ForwardPicker
              excludeId={conversation.id}
              onClose={() => setForwarding(undefined)}
              onPick={async (target) => {
                try {
                  // What this device believes the author to be, and nothing
                  // more: our own handle when it is ours, the other person's
                  // in a DM, and nothing at all in a group, where the sender
                  // of a message cannot be resolved to a name here. The reader
                  // is then told only that it was forwarded, which is true.
                  const from =
                    forwarding.authorId === "me"
                      ? account?.handle
                      : conversation.kind === "dm"
                        ? peerHandle(conversation, account?.handle)
                        : undefined;
                  await forwardMessage(
                    conversation.id,
                    Number(forwarding.id),
                    target,
                    from,
                  );
                  setForwarding(undefined);
                  await notify("Forwarded", "The message was sent on.");
                } catch (error) {
                  await notify(
                    "Couldn't forward that",
                    asConversationError(error).message,
                  );
                }
              }}
            />
          ) : null}
          {searchOpen ? (
            <ConversationSearch
              conversationId={conversation.id}
              onClose={() => setConversationSearch(false)}
            />
          ) : null}
          <MessageList
            messages={messages}
            now={now}
            conversation={conversation}
            onChanged={onChanged}
            onReply={setReplyingTo}
            onForward={setForwarding}
          />
          {typing ? (
            // Above the composer, where the next message will appear -- the
            // place somebody is already looking. In the header it would be a
            // status about the conversation rather than a thing happening in it.
            <div className="text-text-lo flex items-center gap-1.5 px-3 pb-1 text-meta">
              <span className="flex gap-0.5" aria-hidden>
                <span className="bg-text-lo size-1 rounded-full motion-safe:animate-pulse" />
                <span className="bg-text-lo size-1 rounded-full motion-safe:animate-pulse [animation-delay:150ms]" />
                <span className="bg-text-lo size-1 rounded-full motion-safe:animate-pulse [animation-delay:300ms]" />
              </span>
              {conversation.kind === "dm"
                ? `${conversation.title} is typing…`
                : "Someone is typing…"}
            </div>
          ) : null}
          <Composer
            onSend={(body, attachment) => {
              if (attachment) void onSendFile(attachment, body);
              // A reply and an attachment are two different messages, and the
              // file is the one that was just chosen -- so a pending reply is
              // left standing rather than silently spent on it.
              else if (replyingTo?.clientId) {
                void onSendReply(body, replyingTo.clientId);
                setReplyingTo(undefined);
              } else void onSend(body);
            }}
            onSendVoice={(recording) => void onSendVoice(recording)}
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
              void onSendSticker(pack, stickerId)
            }
            {...(conversation.kind === "dm"
              ? { onSendViewOnce: () => void pickAndSendOnce() }
              : {})}
            conversationId={conversation.id}
            conversationTitle={conversation.title}
          />
        </>
      )}
    </Panel>
  );
}
