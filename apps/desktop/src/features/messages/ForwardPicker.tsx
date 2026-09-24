import { useEffect, useState } from "react";

import { useApp } from "../../app/store";
import {
  asConversationError,
  listConversations,
  type Conversation as ConversationWire,
} from "../../lib/conversations";
import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Feedback";
import { ConversationAvatar } from "../../components/ui/ConversationAvatar";
import { Modal } from "../../components/ui/Modal";

/**
 * Choosing where a message goes next.
 *
 * # Why it asks for the list itself
 *
 * The list it needs is the one the shell already holds, but this opens from
 * inside a message bubble — four levels below it — and threading the whole
 * conversation list down through the message rows to be used by one modal that
 * is usually closed is a worse trade than one call when it opens. It is a read
 * of the local store, not the network.
 *
 * # Why the conversation you are in is still offered
 *
 * Forwarding a message back into the conversation it came from is a strange
 * thing to want, but it is not a mistake the app should decide it knows
 * better about — quoting yourself onward in the same thread is a real habit.
 */
export function ForwardPicker({
  excludeId,
  onPick,
  onClose,
}: {
  /** Rendered with a quiet note rather than hidden — see above. */
  excludeId: string;
  onPick: (conversationId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [conversations, setConversations] = useState<ConversationWire[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const overrides = useApp((s) => s.conversationOverrides);

  useEffect(() => {
    let cancelled = false;
    void listConversations()
      .then((found) => {
        if (cancelled) return;
        // Archived ones are out: they are the conversations somebody put away,
        // and a picker is not the place to bring them back.
        // Teams are out too: a forward into one would land on its board as
        // a post from somebody who meant to send a message.
        setConversations(
          found.filter((c) => c.kind !== "team" && !overrides[c.conversation_id]?.archived),
        );
      })
      .catch((error) => {
        if (!cancelled) setProblem(asConversationError(error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [overrides]);

  return (
    <Modal label="Forward to" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-text-mid text-meta leading-relaxed">
          The message is encrypted again for whoever is there — it is sent
          afresh, not moved. They are told it was forwarded.
        </p>

        {problem ? (
          <Callout tone="warning" icon="alert">
            {problem}
          </Callout>
        ) : null}

        <ul className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.conversation_id}>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onPick(c.conversation_id);
                  } finally {
                    setBusy(false);
                  }
                }}
                className="rounded-control flex w-full items-center gap-3 px-2 py-2 text-left transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)] enabled:hover:bg-fill-hover enabled:active:bg-fill-active disabled:cursor-not-allowed disabled:text-text-disabled"
              >
                <ConversationAvatar
                  conversationId={c.conversation_id}
                  kind={c.kind === "group" ? "group" : "dm"}
                  title={c.title ?? "Unnamed conversation"}
                  hasAvatar={c.has_avatar}
                  size={32}
                />
                <span className="min-w-0 flex-1">
                  <span className="text-text-hi block truncate text-body">
                    {c.title ?? "Unnamed conversation"}
                  </span>
                  {c.conversation_id === excludeId ? (
                    <span className="text-text-lo block text-[11px]">
                      the one you are in
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {conversations.length === 0 && !problem ? (
          <p className="text-text-lo text-meta">Nowhere to forward it to yet.</p>
        ) : null}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
