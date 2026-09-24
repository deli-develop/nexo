import { useState } from "react";

import { useApp } from "../../app/store";
import { Button } from "../../components/ui/Button";
import { Field, TextArea } from "../../components/ui/Controls";
import { Modal } from "../../components/ui/Modal";
import { createTeam } from "../../lib/teams";

/**
 * Starting a team.
 *
 * Names it and, optionally, says what it is for. Nobody is added here: the
 * team exists with you as its owner, and people are added from its members
 * screen, where each add can say why it did or did not work. The dialog says
 * what a team is before anybody makes one -- private to its members, and
 * nothing anybody else can find.
 */
export function CreateTeamDialog({ onCreated }: { onCreated: (id: string) => void }) {
  const close = useApp((s) => s.setCreateTeamOpen);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <Modal label="New team" onClose={() => close(false)}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || name.trim() === "") return;
          setBusy(true);
          setProblem(null);
          try {
            const id = await createTeam(name, description);
            close(false);
            onCreated(id);
          } catch (error) {
            setProblem(error instanceof Error ? error.message : "The team was not created.");
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-panel bg-surface-2 flex max-h-full w-full max-w-[440px] flex-col border border-line"
      >
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
          <div>
            <h2 className="text-text-hi font-display text-[17px] font-medium">New team</h2>
            <p className="text-text-mid mt-1.5 text-meta leading-relaxed">
              A private board for the people you add. Everything posted in it is end-to-end encrypted;
              nobody outside it can read it or find it. You'll be its owner.
            </p>
          </div>
          <Field
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoFocus
            required
          />
          <TextArea
            label="What it's for (optional)"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            maxLength={500}
          />
          {problem ? <p className="text-danger text-meta">{problem}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--hairline)] p-3">
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || name.trim() === ""}>
            {busy ? "Creating…" : "Create team"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
