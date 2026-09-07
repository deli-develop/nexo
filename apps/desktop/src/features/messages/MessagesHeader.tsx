import { isMuted, useApp } from "../../app/store";
import { useLayout } from "../../app/useLayout";
import { useState } from "react";
import { notify, pickFile } from "../../lib/native";
import {
  addToConversation,
  asConversationError,
  renameConversation,
  setConversationAvatar,
} from "../../lib/conversations";
import type { LiveConversations } from "../../app/useConversations";
import { HandleAvatar } from "../../components/ui/HandleAvatar";
import { ConversationAvatar } from "../../components/ui/ConversationAvatar";
import { Button, IconButton } from "../../components/ui/Button";
import { startCall, useCall } from "../calls/useCall";
import { Field } from "../../components/ui/Controls";
import { Callout } from "../../components/ui/Feedback";
import { Modal } from "../../components/ui/Modal";
import { Icon } from "../../components/ui/Icon";

/**
 * The Messages cells of the top row: the account, the conversation, the panel
 * actions. They are here rather than inside each pane so that the column
 * hairlines line up down the whole window — the account cell is exactly as
 * wide as the conversation list, the actions cell exactly as wide as the
 * context panel.
 */
export function MessagesHeader({
  now,
  live,
}: {
  now: Date;
  /** Mounted once by the shell and shared with the page — see `AppShell`. */
  live: LiveConversations;
}) {
  const activeId = useApp((s) => s.activeConversationId);
  const go = useApp((s) => s.go);
  const showPresence = useApp((s) => s.preferences.presence);
  const contextOpen = useApp((s) => s.contextPanelOpen);
  const toggleContext = useApp((s) => s.toggleContextPanel);
  const setDrawer = useApp((s) => s.setListDrawer);
  const searchOpen = useApp((s) => s.conversationSearchOpen);
  const setConversationSearch = useApp((s) => s.setConversationSearch);
  const mute = useApp((s) => s.muteConversation);
  const overrides = useApp((s) => s.conversationOverrides);
  // One call at a time, so the button goes quiet while one is up rather than
  // starting a second that `applySignal` would only decline.
  const callBusy = useCall((s) => s.phase !== "idle");
  const layout = useLayout();

  const account = useApp((s) => s.account);

  const base = live.conversations.find((c) => c.id === activeId);
  const conversation = base ? { ...base, ...overrides[base.id] } : undefined;
  // Read once per render rather than per use: two reads of the clock inside
  // one paint can disagree about a mute that is expiring, and the label and
  // the pressed state would then contradict each other.
  const muted = base ? isMuted(overrides[base.id], now.getTime()) : false;

  // No profile directory yet (M7), so there is nobody to look up: the avatar
  // is seeded from the conversation and presence is simply not shown rather
  // than guessed at. Same call as the list rows make.
  void showPresence;
  void now;

  const [addOpen, setAddOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const subtitle = !conversation
    ? ""
    : conversation.kind === "group"
      ? `${conversation.memberIds.length} members`
      : "";

  return (
    <>
      {layout.canShowList ? (
        <div className="flex w-[300px] shrink-0 items-center gap-3 border-r border-[var(--hairline)] px-4">
          <HandleAvatar handle={account?.handle ?? ""} name={account?.display_name ?? ""} size={36} />
          <button
            type="button"
            onClick={() => go("profile")}
            className="no-drag min-w-0 flex-1 text-left"
          >
            <span className="text-text-hi block truncate text-body font-medium">
              {account?.display_name ?? ""}
            </span>
            <span className="text-text-lo block truncate text-[11px]">@{account?.handle ?? ""}</span>
          </button>
          <div className="no-drag">
            <IconButton
              name="more"
              label="Account options"
              size={16}
              onClick={() =>
                void notify("Account options", "Switching accounts and adding a second device arrive in a later milestone.")
              }
            />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 items-center gap-3 px-4">
        {!layout.canShowList ? (
          <div className="no-drag">
            <IconButton
              name="chevronLeft"
              label="Show conversations"
              onClick={() => setDrawer(true)}
            />
          </div>
        ) : null}

        {conversation ? (
          <>
            <ConversationAvatar
              conversationId={conversation.id}
              kind={conversation.kind}
              title={conversation.title}
              hasAvatar={conversation.hasAvatar ?? false}
              size={36}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h1 className="text-text-hi truncate text-body font-medium">
                  {conversation.title}
                </h1>
                {/* §4.4: the lock shows in E2EE conversations only, never on
                    the feed or a profile. Unverified is a quiet outline of the
                    same shield, not a coloured badge — §4.1 asks for a loud
                    banner when a key *changes*, not for a standing alarm. */}
                <Icon
                  name="lock"
                  size={12}
                  className="text-success shrink-0"
                  aria-label="End-to-end encrypted"
                />
                <Icon
                  name="shield"
                  size={12}
                  className={cnShield(conversation.verified)}
                  aria-label={
                    conversation.verified ? "Safety number verified" : "Safety number not verified"
                  }
                />
              </div>
              <p className="text-text-lo truncate text-[11px]">{subtitle}</p>
            </div>
            <div className="no-drag flex items-center gap-0.5">
              <IconButton
                name="search"
                label="Search in conversation"
                size={17}
                active={searchOpen}
                onClick={() => setConversationSearch(!searchOpen)}
              />
              <IconButton
                name="pencil"
                label="Rename this conversation"
                size={17}
                onClick={() => setRenaming(true)}
              />
            </div>
          </>
        ) : null}
      </div>

      <div
        className={
          "no-drag flex shrink-0 items-center gap-0.5 border-l border-[var(--hairline)] px-4" +
          (contextOpen && layout.canShowContext ? " w-[280px]" : "")
        }
      >
        <IconButton
          name="phone"
          label="Start a voice call"
          size={17}
          // Only in a DM. A group call is a different thing entirely -- one
          // connection per pair stops scaling almost immediately -- and a
          // button that rings one arbitrary member of a group would be worse
          // than no button.
          disabled={!conversation || conversation.kind !== "dm" || callBusy}
          onClick={() => conversation && void startCall(conversation.id)}
        />
        <IconButton
          name="userPlus"
          label="Add someone to this conversation"
          size={17}
          disabled={!conversation}
          onClick={() => setAddOpen(true)}
        />
        <IconButton
          name="bell"
          label={muted ? "Unmute this conversation" : "Mute this conversation"}
          size={17}
          active={muted}
          // The header offers the plain on/off. Muting *for a while* lives in
          // the row's own menu, where a list of durations costs nothing; up
          // here it would be a menu hanging off a toolbar button for a choice
          // most people make once.
          onClick={() =>
            conversation && mute(conversation.id, muted ? null : Number.POSITIVE_INFINITY)
          }
        />
        <IconButton
          name="info"
          label={contextOpen ? "Hide details" : "Show details"}
          size={17}
          active={contextOpen && layout.canShowContext}
          onClick={toggleContext}
        />

      </div>

      {addOpen && conversation ? (
        <AddSomeone
          conversation={conversation}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            void live.refresh();
          }}
        />
      ) : null}

      {renaming && conversation ? (
        <RenameConversation
          conversation={conversation}
          hadPicture={conversation.hasAvatar ?? false}
          onClose={() => setRenaming(false)}
          onRenamed={() => {
            setRenaming(false);
            void live.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Adding a member to an existing conversation.
 *
 * A dialog rather than a prompt because there is something to say first:
 * adding someone rekeys the group, so they can read from here on and nothing
 * before. That is MLS's guarantee rather than a policy this app chose, and it
 * belongs in front of the decision instead of in an explanation afterwards.
 */
function AddSomeone({
  conversation,
  onClose,
  onAdded,
}: {
  conversation: { id: string; title: string };
  onClose: () => void;
  onAdded: () => void;
}) {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const who = handle.trim().toLowerCase();
    if (!who || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addToConversation(conversation.id, who);
      await notify("Added", `@${who} is now in ${conversation.title}.`);
      onAdded();
    } catch (raw) {
      const e = asConversationError(raw);
      setError(
        e.kind === "rejected"
          ? "That handle has no key package available. They need to have opened Nexo at least once."
          : e.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label="Add someone to this conversation" onClose={onClose}>
      <form
        onSubmit={submit}
        className="rounded-panel bg-surface-2 w-full max-w-[340px] border border-line p-5"
      >
        <h2 className="text-text-hi font-display text-[17px] font-medium">Add someone</h2>
        <p className="text-text-lo mt-1.5 text-meta">
          They will be able to read {conversation.title} from now on, and nothing said
          before it.
        </p>

        <Field
          label="Handle"
          className="mt-4"
          value={handle}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="alice"
          onChange={(e) => setHandle(e.target.value.toLowerCase())}
        />

        {error ? (
          <Callout tone="danger" icon="alert" className="mt-3">
            {error}
          </Callout>
        ) : null}

        <div className="mt-4 flex gap-2">
          <Button type="submit" variant="primary" disabled={!handle.trim() || busy}>
            {busy ? "Adding…" : "Add"}
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Renaming a conversation.
 *
 * The new name travels as an encrypted message, so everyone in the conversation
 * ends up calling it the same thing and the server never learns what that is.
 * Saying so matters: a name that only you could see would be a different
 * feature wearing the same button.
 */
function RenameConversation({
  conversation,
  hadPicture,
  onClose,
  onRenamed,
}: {
  conversation: { id: string; title: string };
  hadPicture: boolean;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [title, setTitle] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Starts from whatever the conversation already had, and flips once one is
  // chosen here — so the preview beside the button shows the new picture
  // rather than the one the dialog opened with.
  const [hasPicture, setHasPicture] = useState(hadPicture);

  async function changePicture() {
    const file = await pickFile({ title: "Choose a picture", images: true });
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setConversationAvatar(conversation.id, file.path);
      // Remounts the preview, which is what makes it fetch the new bytes.
      setHasPicture(false);
      setHasPicture(true);
    } catch (raw) {
      setError(asConversationError(raw).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = title.trim();
    if (!next || busy) return;
    setBusy(true);
    setError(null);
    try {
      await renameConversation(conversation.id, next);
      onRenamed();
    } catch (raw) {
      setError(asConversationError(raw).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label="Rename this conversation" onClose={onClose}>
      <form
        onSubmit={submit}
        className="rounded-panel bg-surface-2 w-full max-w-[340px] border border-line p-5"
      >
        <h2 className="text-text-hi font-display text-[17px] font-medium">Rename</h2>
        <p className="text-text-lo mt-1.5 text-meta">
          Everyone in the conversation will see the new name. It is sent encrypted, so the
          server never learns it.
        </p>

        <Field
          label="Name"
          className="mt-4"
          value={title}
          maxLength={80}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
        />

        <div className="mt-3 flex items-center gap-3">
          <ConversationAvatar
            conversationId={conversation.id}
            kind="group"
            title={conversation.title}
            hasAvatar={hasPicture}
            size={44}
          />
          <Button icon="camera" disabled={busy} onClick={() => void changePicture()}>
            Change picture
          </Button>
        </div>

        {error ? (
          <Callout tone="danger" icon="alert" className="mt-3">
            {error}
          </Callout>
        ) : null}

        <div className="mt-4 flex gap-2">
          <Button type="submit" variant="primary" disabled={!title.trim() || busy}>
            {busy ? "Renaming\u2026" : "Rename"}
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function cnShield(verified: boolean): string {
  return verified ? "text-success shrink-0" : "text-text-lo shrink-0";
}
