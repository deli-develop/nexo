import { useState } from "react";

import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Controls";
import { Callout } from "../../components/ui/Feedback";
import { asAuthError, changePassword } from "../../lib/auth";

/**
 * Change password (§6.4).
 *
 * Three fields, and the confirmation is not ceremony: a typo in a new password
 * nobody can recover is an account lost, and this app means that literally —
 * there is no reset link, because the server holds nothing that could send one.
 *
 * The form asks for the current password even though the session is already
 * signed in. A bearer token is possession of an unlocked machine; the password
 * is knowledge. Someone who sits down at a desk for thirty seconds must not be
 * able to lock the owner out of their own account.
 */
export function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Deliberately only two rules, both of them structural. A strength meter
  // would be theatre: the client stretches with Argon2id at 64 MiB either way,
  // and the honest advice ("make it long, make it unique") is in the hint.
  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 8;
  const canSubmit =
    current.length > 0 && next.length >= 8 && next === confirm && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (raw) {
      setError(asAuthError(raw).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 py-3">
      <p className="text-text-mid max-w-[60ch] text-meta leading-relaxed">
        Your password is stretched on this machine before anything is sent. The server
        stores a hash of the result and never sees the password itself. Changing it does
        not touch your messages. They are not kept under your password — on this device
        they are not encrypted at all — so nothing is re-encrypted and no history is lost.
      </p>

      <div className="grid max-w-[420px] gap-3">
        <Field
          label="Current password"
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          disabled={busy}
        />
        <Field
          label="New password"
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          disabled={busy}
          hint="At least 8 characters. Long and unique beats short and clever."
          {...(tooShort ? { error: "Use at least 8 characters." } : {})}
        />
        <Field
          label="Confirm new password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          disabled={busy}
          {...(mismatch ? { error: "These two do not match." } : {})}
        />
      </div>

      {error ? (
        <Callout tone="danger" icon="alert" title="Couldn't change it.">
          {error}
        </Callout>
      ) : null}

      {done ? (
        <Callout tone="neutral" icon="check" title="Password changed.">
          Any other signed-in session has been signed out. This one stays.
        </Callout>
      ) : null}

      <div>
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {busy ? "Changing…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}
