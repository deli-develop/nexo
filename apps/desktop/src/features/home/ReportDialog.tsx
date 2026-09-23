import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { TextArea } from "../../components/ui/Controls";
import { Callout } from "../../components/ui/Feedback";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/cn";
import { notify } from "../../lib/native";
import {
  asPeopleError,
  report,
  type ReportReason,
  type ReportSubject,
} from "../../lib/people";

/** What a report can be, and what each choice means, in the server's order. */
const REASONS: { id: ReportReason; label: string; description: string }[] = [
  { id: "spam", label: "Spam", description: "Advertising, scams, or the same thing over and over." },
  {
    id: "harassment",
    label: "Harassment",
    description: "Aimed at somebody to hurt, threaten or frighten them.",
  },
  { id: "illegal", label: "Illegal", description: "Something it is against the law to post." },
  { id: "impersonation", label: "Impersonation", description: "Pretending to be somebody else." },
  { id: "other", label: "Something else", description: "Say what in the note." },
];

/** The server refuses a longer note. */
const MAX_NOTE = 1000;

/**
 * Reporting a post, a comment or a person (`/v1/reports`).
 *
 * One dialog for all three, because the promise is the same and has to be
 * worded the same: somebody who runs the server reads it, nothing disappears
 * automatically, the person reported is not told, and you are told only that
 * it arrived. That is `apps/server/src/reports.rs` as the person filing the
 * report meets it. A dialog that implied more — a moderation team, a
 * verdict, a follow-up — would be the overstated promise rule 5 forbids.
 *
 * It says what blocking does instead, because the two get confused and only
 * one of them is about you.
 */
export function ReportDialog({
  subject,
  id,
  name,
  onClose,
}: {
  subject: ReportSubject;
  id: number;
  /** Whose post or comment, or who: a display name. */
  name: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title =
    subject === "post"
      ? `Report ${name}'s post`
      : subject === "comment"
        ? `Report ${name}'s comment`
        : `Report ${name}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      await report(subject, id, reason, note.trim() || undefined);
      onClose();
      await notify(
        "Report sent",
        "It arrived. You won't hear what happens next — that goes for every report.",
      );
    } catch (raw) {
      setError(asPeopleError(raw).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label={title} onClose={onClose}>
      <form
        onSubmit={submit}
        className="rounded-panel bg-surface-2 flex max-h-full w-full max-w-[420px] flex-col border border-line"
      >
        <div className="min-h-0 overflow-y-auto p-5">
          <h2 className="text-text-hi font-display text-[17px] font-medium">{title}</h2>
          <p className="text-text-mid mt-1.5 text-meta leading-relaxed">
            A person who runs this server reads every report. Nothing is hidden
            automatically, and {name} is not told about it. If you only want to
            stop seeing {name}, block them instead.
          </p>

          <fieldset className="mt-4 flex flex-col gap-1">
            <legend className="text-text-mid mb-1.5 text-meta font-medium">Why</legend>
            {REASONS.map((option) => (
              <label
                key={option.id}
                className={cn(
                  "rounded-control flex cursor-pointer items-start gap-3 px-2.5 py-2 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
                  reason === option.id ? "bg-accent/10" : "hover:bg-fill-hover",
                )}
              >
                <input
                  type="radio"
                  name="report-reason"
                  checked={reason === option.id}
                  onChange={() => setReason(option.id)}
                  className="accent-accent mt-1"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-text-hi text-body">{option.label}</span>
                  <span className="text-text-mid text-meta">{option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="mt-4">
            <TextArea
              label="A note (optional)"
              className="min-h-[88px]"
              rows={3}
              maxLength={MAX_NOTE}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              hint={`Read by whoever reads the report. ${MAX_NOTE - note.length} characters left.`}
            />
          </div>

          {error ? (
            <Callout tone="danger" icon="alert" className="mt-3">
              {error}
            </Callout>
          ) : null}
        </div>

        <div className="flex gap-2 border-t border-[var(--hairline)] px-5 py-4">
          <Button type="submit" variant="primary" disabled={!reason || busy}>
            {busy ? "Sending…" : "Send report"}
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
