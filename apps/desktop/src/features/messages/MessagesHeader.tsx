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
import { ConversationAvatar } from "../../components/ui/ConversationAvatar";
import { Button, IconButton } from "../../components/ui/Button";
import { Field } from "../../components/ui/Controls";
import { Callout } from "../../components/ui/Feedback";
import { Modal } from "../../components/ui/Modal";
import { Icon } from "../../components/ui/Icon";
import { ContextMenu, type MenuItem } from "../../components/ui/ContextMenu";
import { cn } from "../../lib/cn";
import { captionWidth } from "../../components/chrome/TopBar";
import { peerHandle } from "./peer";

/**
 * The Messages cells of the top row: the page's title, the conversation, the
 * panel actions. They are here rather than inside each pane so that the column
 * hairlines line up down the whole window — the title cell is exactly as wide
 * as the conversation list, the actions cell exactly as wide as the context
 * panel.
 *
 * **The title cell says "Messages", like every destination's does.** It used
 * to be your own name and handle with a "⋯" beside it: a second copy of the
 * face already at the foot of the rail, and a menu of Profile, Settings and
 * Sign out that were all a rail button away. It named the account rather
 * than the page, and nobody reading it could tell what the dots were for.
 *
 * **Each button is drawn only where it can act.** The actions cell used to
 * stand with nothing open — add someone to no conversation, mute nothing — and
 * on a phone the whole row did not fit: the title shrank to nothing and the
 * lock landed on top of the search button. On a phone the conversation's
 * actions other than search go into one menu, and there is no actions cell.
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
  const account = useApp((s) => s.account);
  const viewProfile = useApp((s) => s.viewProfile);
  const showPresence = useApp((s) => s.preferences.presence);
  const contextOpen = useApp((s) => s.contextPanelOpen);
  const toggleContext = useApp((s) => s.toggleContextPanel);
  const sheetOpen = useApp((s) => s.contextSheetOpen);
  const setSheet = useApp((s) => s.setContextSheet);
  const closeConversation = useApp((s) => s.closeConversation);
  const searchOpen = useApp((s) => s.conversationSearchOpen);
  const setConversationSearch = useApp((s) => s.setConversationSearch);
  const mute = useApp((s) => s.muteConversation);
  const overrides = useApp((s) => s.conversationOverrides);
  // starting a second that `applySignal` would only decline.
  const layout = useLayout();


  const base = live.conversations.find((c) => c.id === activeId);
  const conversation = base ? { ...base, ...overrides[base.id] } : undefined;
  // Read once per render rather than per use: two reads of the clock inside
  // one paint can disagree about a mute that is expiring, and the label and
  // the pressed state would then contradict each other.
  const muted = base ? isMuted(overrides[base.id], now.getTime()) : false;
  // Who a one-to-one is with, from the member list -- never the title, which
  // is a label. A group, Saved messages or a DM whose members are not known
  // yet has nobody to open, and its header stays text.
  const peer = conversation ? peerHandle(conversation, account?.handle) : undefined;

  // No profile directory yet (M7), so there is nobody to look up: the avatar
  // is seeded from the conversation and presence is simply not shown rather
  // than guessed at. Same call as the list rows make.
  void showPresence;
  void now;

  const [addOpen, setAddOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  // The column from 1280px up, the sheet or the phone's screen below it —
  // the same button either way. See `contextSheetOpen`.
  const detailsShown = layout.canShowContext ? contextOpen : sheetOpen;
  const captions = captionWidth();
  const columnWidth = contextOpen && layout.canShowContext ? 280 - captions : null;
  const toggleDetails = () =>
    layout.canShowContext ? toggleContext() : setSheet(!sheetOpen);
  const toggleMute = () =>
    conversation && mute(conversation.id, muted ? null : Number.POSITIVE_INFINITY);

  // What the phone's menu offers: the actions the wider header draws as
  // buttons. Search stays out in the row, because it is reached for mid-read.
  const phoneMenu: MenuItem[] = [
    { label: "Details", icon: "info", onSelect: () => setSheet(true) },
    { label: "Rename", icon: "pencil", onSelect: () => setRenaming(true) },
    { label: "Add someone", icon: "userPlus", onSelect: () => setAddOpen(true) },
    { label: muted ? "Unmute" : "Mute", icon: "bell", onSelect: toggleMute },
  ];

  const avatar = conversation ? (
    <ConversationAvatar
      conversationId={conversation.id}
      kind={conversation.kind}
      title={conversation.title}
      hasAvatar={conversation.hasAvatar ?? false}
      version={conversation.avatarVersion}
      size={layout.phone ? 32 : 36}
    />
  ) : null;

  const subtitle = !conversation
    ? ""
    : conversation.kind === "group"
      ? `${conversation.memberIds.length} members`
      : "";

  return (
    <>
      {layout.canShowList ? (
        <div className="flex w-[300px] shrink-0 items-center border-r border-[var(--hairline)] px-5">
          <h1 className="font-display text-text-hi text-title font-semibold tracking-[-0.01em]">
            Messages
          </h1>
        </div>
      ) : null}

      <div
        className={cn(
          "flex min-w-0 flex-1 items-center",
          // Tighter on a phone, where the back arrow is the first thing in
          // the row and 16px before it is 16px the title does not get.
          layout.phone ? "gap-2 pr-2 pl-1" : "gap-3 px-4",
        )}
      >
        {/* Back, and only when there is something to go back from. This used
            to open a drawer over the conversation at every narrow width,
            including when no conversation was open — a button that slid a
            panel over nothing. */}
        {layout.phone && conversation ? (
          <div className="no-drag">
            {/* Back out of the details first, when they are open: they
                replaced the chat, and the chat is where back leads. */}
            <IconButton
              name="chevronLeft"
              label={sheetOpen ? "Back to the conversation" : "Back to conversations"}
              onClick={sheetOpen ? () => setSheet(false) : closeConversation}
            />
          </div>
        ) : null}

        {conversation ? (
          <>
            {/* The face and the name are the way to their profile, as they
                are beside the feed and in every messenger people use. There
                used to be no way from a chat to the person in it. */}
            {peer ? (
              <button
                type="button"
                onClick={() => viewProfile(peer)}
                aria-label={`Open ${conversation.title}'s profile`}
                className="no-drag focus-visible:ring-accent flex shrink-0 rounded-full outline-none transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-state)] hover:opacity-80 focus-visible:ring-2"
              >
                {avatar}
              </button>
            ) : (
              avatar
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h1 className="text-text-hi min-w-0 truncate text-body font-medium">
                  {peer ? (
                    <button
                      type="button"
                      onClick={() => viewProfile(peer)}
                      title="View profile"
                      className="no-drag focus-visible:ring-accent max-w-full truncate rounded-[4px] text-left outline-none hover:underline focus-visible:ring-1"
                    >
                      {conversation.title}
                    </button>
                  ) : (
                    conversation.title
                  )}
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
              {layout.phone ? (
                <IconButton
                  name="more"
                  label="Conversation options"
                  size={17}
                  active={menuAt !== null}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setMenuAt({ x: box.right, y: box.bottom + 4 });
                  }}
                />
              ) : (
                <IconButton
                  name="pencil"
                  label="Rename this conversation"
                  size={17}
                  onClick={() => setRenaming(true)}
                />
              )}
            </div>
          </>
        ) : layout.phone ? (
          // The list is the screen, so the row says which one, the way every
          // other destination's does.
          <h1 className="font-display text-text-hi text-title px-5 font-semibold tracking-[-0.01em]">
            Messages
          </h1>
        ) : null}
      </div>

      {menuAt ? (
        <ContextMenu items={phoneMenu} at={menuAt} onClose={() => setMenuAt(null)} />
      ) : null}

      {conversation && !layout.phone ? (
      <div
        className={cn(
          "no-drag flex shrink-0 items-center gap-0.5 border-l border-[var(--hairline)]",
          // 142px in the desktop app: three buttons fit, with less room at
          // the end, where the caption buttons follow anyway.
          columnWidth !== null && captions > 0 ? "pr-2 pl-4" : "px-4",
        )}
        // Exactly over the context panel. The caption buttons come after
        // this cell and the panel runs under them, so the cell is the panel's
        // width less theirs — see `captionWidth`.
        style={columnWidth === null ? undefined : { width: columnWidth }}
      >
        <IconButton
          name="userPlus"
          label="Add someone to this conversation"
          size={17}
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
          onClick={toggleMute}
        />
        <IconButton
          name="info"
          label={detailsShown ? "Hide details" : "Show details"}
          size={17}
          active={detailsShown}
          onClick={toggleDetails}
        />
      </div>
      ) : null}

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
  // Bumped when a picture is chosen here, which is what makes the preview
  // fetch the new bytes. Flipping `hasPicture` off and on again did nothing:
  // React batches the two, so the preview never saw it change.
  const [pictureVersion, setPictureVersion] = useState(0);

  async function changePicture() {
    const file = await pickFile({ title: "Choose a picture", images: true });
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setConversationAvatar(conversation.id, file);
      setHasPicture(true);
      setPictureVersion((version) => version + 1);
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
            version={String(pictureVersion)}
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
