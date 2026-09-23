import { useEffect, useState } from "react";

import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Controls";
import { Callout } from "../../components/ui/Feedback";
import { Icon } from "../../components/ui/Icon";
import {
  asAuthError,
  login,
  pinStatus,
  unlockWithPin,
  type Account,
  type PinStatus,
} from "../../lib/auth";

/**
 * The lock screen (§8).
 *
 * Drawn *instead of* the app, not over it. An overlay would leave the
 * conversation in the DOM underneath, one `display:none` away from readable —
 * the shell renders this or the app, never both.
 *
 * Locking (`lockSession` in `lib/auth.ts`) dropped the tokens and the MLS
 * state from memory, not from disk: everything this device keeps is still in
 * IndexedDB, unencrypted. So this screen guards the screen, and its copy claims
 * nothing more.
 *
 * The two ways in are not the same weight. The **password** is a real
 * sign-in: it re-derives the verifier against the server's salt. The **PIN**
 * is checked on this machine and never leaves it; a correct one resumes the
 * session from the refresh token still in the store (`Session.resume`). Both
 * need the server.
 *
 * Only a wrong PIN is drawn as a wrong PIN. `unlockWithPin` resolving to
 * `null` is the sole thing that means the digits were wrong; the failures that
 * are not about the digits arrive as errors and say what they were.
 *
 * The handle is shown, not asked: this machine knows who it belongs to, and
 * being locked should not look like being signed out.
 */
export function LockScreen({
  account,
  onUnlocked,
}: {
  account: Account;
  onUnlocked: () => void;
}) {
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which way in is being offered. The PIN when there is one, until it is
  // exhausted or the user asks for the password.
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [usePassword, setUsePassword] = useState(false);

  useEffect(() => {
    void pinStatus()
      .then(setStatus)
      .catch(() => setStatus({ set: false, attempts_left: 0 }));
  }, []);

  const pinOffered = status?.set === true && status.attempts_left > 0 && !usePassword;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    if (pinOffered) {
      if (pin.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const account = await unlockWithPin(pin);
        setPin("");
        if (account) {
          onUnlocked();
          return;
        }
        // Wrong. Re-read rather than counting locally: the count lives beside
        // the verifier, and this is the only honest source for what is left.
        const next = await pinStatus();
        setStatus(next);
        setError(
          next.attempts_left > 0
            ? `That PIN is wrong. ${next.attempts_left} ${next.attempts_left === 1 ? "try" : "tries"} left.`
            : "Too many attempts. Sign in with your password.",
        );
      } catch (raw) {
        const e = asAuthError(raw);
        setError(e.message);
        if (e.kind === "pin_locked") setStatus({ set: true, attempts_left: 0 });
        // The PIN was right and the session is gone, so no number of further
        // tries at it will help. Offering the password is the only thing left
        // that can work, and switching to it beats leaving somebody on a field
        // that has already done its job.
        if (e.kind === "signed_out") {
          setUsePassword(true);
          setPin("");
        }
      } finally {
        setBusy(false);
      }
      return;
    }

    if (password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await login(account.handle, password);
      setPassword("");
      onUnlocked();
    } catch (raw) {
      setError(asAuthError(raw).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={submit} className="flex w-full max-w-[360px] flex-col gap-5">
        <div className="self-center">
          <Avatar seed={account.handle} name={account.display_name} size={64} />
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-text-hi text-lg font-semibold">Locked</h1>
          <p className="text-text-mid text-meta leading-relaxed">
            Signed in as <span className="text-text-hi font-medium">@{account.handle}</span>.
            {pinOffered
              ? " Enter your PIN to continue."
              : " Enter your password to continue."}
          </p>
        </div>

        {pinOffered ? (
          <Field
            label="PIN"
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            autoFocus
            autoComplete="off"
            disabled={busy}
          />
        ) : (
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            disabled={busy}
          />
        )}

        {error ? (
          <Callout tone="danger" icon="alert" title="Couldn't unlock.">
            {error}
          </Callout>
        ) : null}

        <Button
          type="submit"
          disabled={(pinOffered ? pin.length === 0 : password.length === 0) || busy}
          className="w-full"
        >
          {busy ? "Unlocking…" : "Unlock"}
        </Button>

        {pinOffered ? (
          <button
            type="button"
            onClick={() => {
              setUsePassword(true);
              setError(null);
            }}
            className="text-text-lo hover:text-text-hi self-center text-[11px] underline decoration-line-strong underline-offset-2"
          >
            Use my password instead
          </button>
        ) : null}

        <p className="text-text-lo flex items-center gap-1.5 self-center text-[11px]">
          <Icon name="lock" size={12} />
          {pinOffered
            ? "The PIN works on this machine only, and never leaves it."
            : "Unlocking needs the server — it is a full sign-in, not a curtain."}
        </p>
      </form>
    </div>
  );
}
