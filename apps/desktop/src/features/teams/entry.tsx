import { conversations as core, type BoardReaction } from "@nexo/core";
import { useState } from "react";

import { Button, IconButton } from "../../components/ui/Button";
import { EmojiPicker } from "../../components/ui/EmojiPicker";
import { TextArea } from "../../components/ui/Controls";
import { useContextMenu } from "../../components/ui/ContextMenu";
import { cn } from "../../lib/cn";
import { reactToMessage, reviseMessage } from "../../lib/conversations";
import { confirm, copyText } from "../../lib/native";
import { pinPost, removeForEveryone, type Team } from "../../lib/teams";
import { postMenuItems } from "./postMenu";

/**
 * What a post and a comment share: its menu, its reactions, and editing it in
 * place. Posts and comments are messages underneath, so editing, taking back
 * and reacting are the ordinary ones -- `reviseMessage`, `reactToMessage` --
 * named by the post's or comment's `id`.
 */

/** Whether the author may still edit or take something back. */
export function withinWindow(sentAtMs: number): boolean {
  return Date.now() - sentAtMs <= core.EDIT_WINDOW_MS;
}

export function moderates(team: Team): boolean {
  return team.myRole === "owner" || team.myRole === "admin";
}

export function useEntryMenu(input: {
  team: Team;
  id: string;
  body: string;
  mine: boolean;
  sentAtMs: number;
  gone: boolean;
  pinnable: boolean;
  pinned: boolean;
  onEdit: () => void;
  onReact: () => void;
  onChanged: () => void;
}) {
  const { team, id, onChanged } = input;
  const build = () =>
    postMenuItems(
      {
        hasBody: input.body !== "",
        mine: input.mine,
        withinWindow: withinWindow(input.sentAtMs),
        gone: input.gone,
        moderates: moderates(team),
        pinnable: input.pinnable,
        pinned: input.pinned,
      },
      {
        copy: () => void copyText(input.body),
        edit: input.onEdit,
        react: input.onReact,
        togglePin: () => void pinPost(team.id, id, !input.pinned).then(onChanged),
        takeBack: () =>
          void (async () => {
            // The wording is the promise: a request other apps honour.
            const ok = await confirm(
              "Take back",
              "This asks every member's Nexo app to remove it. Copies on a modified app, or saved elsewhere, can remain.",
            );
            if (ok) await reviseMessage(team.id, id, undefined);
            onChanged();
          })(),
        removeForEveryone: () =>
          void (async () => {
            const ok = await confirm(
              "Remove for everyone",
              "This asks every member's Nexo app to stop showing it. It cannot reach a copy somebody already saved, or an app that ignores the request.",
            );
            if (ok) await removeForEveryone(team.id, id);
            onChanged();
          })(),
      },
    );
  const { onContextMenu, menu } = useContextMenu(build);
  return { onContextMenu, menu, hasItems: build().length > 0 };
}

/** The "more" button, which opens the same menu a right-click does. */
export function MoreButton({ onOpen }: { onOpen: (event: React.MouseEvent) => void }) {
  return (
    <IconButton
      name="more"
      label="More"
      size={16}
      className="size-8"
      onClick={(event) => {
        // The menu is anchored where a right-click would have been.
        onOpen(event);
      }}
    />
  );
}

export function Reactions({
  team,
  target,
  reactions,
  picking,
  setPicking,
  onChanged,
}: {
  team: Team;
  target: string;
  reactions: BoardReaction[];
  picking: boolean;
  setPicking: (open: boolean) => void;
  onChanged: () => void;
}) {
  const react = async (emoji: string, on: boolean) => {
    await reactToMessage(team.id, target, emoji, on);
    onChanged();
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          aria-pressed={reaction.mine}
          onClick={() => void react(reaction.emoji, !reaction.mine)}
          className={cn(
            "flex h-7 items-center gap-1 rounded-full px-2.5 text-meta",
            "transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
            reaction.mine
              ? "bg-accent/16 text-accent-soft ring-1 ring-accent/40"
              : "bg-fill text-text-mid hover:bg-fill-hover",
          )}
        >
          <span>{reaction.emoji}</span>
          <span className="tabular">{reaction.count}</span>
        </button>
      ))}
      <div className="relative">
        <IconButton
          name="emoji"
          label="React"
          size={15}
          className="size-7"
          active={picking}
          onClick={() => setPicking(!picking)}
        />
        {picking ? (
          <div className="absolute bottom-9 left-0" style={{ zIndex: 100 }}>
            <EmojiPicker
              onPick={(emoji) => {
                setPicking(false);
                void react(emoji, true);
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Editing the words in place. The title stays as posted -- an edit is the body. */
export function InlineEditor({
  team,
  id,
  initial,
  onDone,
}: {
  team: Team;
  id: string;
  initial: string;
  onDone: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (text.trim() === "" || busy) return;
        setBusy(true);
        try {
          await reviseMessage(team.id, id, text.trim());
        } finally {
          setBusy(false);
          onDone();
        }
      }}
    >
      <TextArea label="Edit" value={text} onChange={(event) => setText(event.target.value)} rows={3} autoFocus />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || text.trim() === ""}>
          Save
        </Button>
      </div>
    </form>
  );
}
