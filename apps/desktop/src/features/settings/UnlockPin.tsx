import { useCallback, useEffect, useState } from "react";

import { asAuthError, pinStatus, setPin as setPinCall, type PinStatus } from "../../lib/auth";
import { notify } from "../../lib/native";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Controls";
import { Callout, Pill } from "../../components/ui/Feedback";
import { SectionHeader } from "../../components/ui/Surface";

/**
 * The unlock PIN, in Settings rather than the profile.
 *
 * It lives here because it answers the same question as the password and the
 * auto-lock timer directly above it: how you get back into *this machine*.
 * Splitting it from the timer it exists to serve — the PIN is only ever asked
 * for after auto-lock fires — meant the two halves of one feature sat in two
 * different menus.
 *
 * What stayed in the profile is the other kind of security: who can see which
 * field, and the fingerprint other people check. That is identity as others
 * encounter it, not access to this device.
 */
export function UnlockPin() {
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await pinStatus());
    } catch {
      setStatus({ set: false, attempts_left: 0 });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    if (pin !== confirmPin) {
      setProblem("Those two PINs are not the same.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await setPinCall(pin);
      setPin("");
      setConfirmPin("");
      setChanging(false);
      await refresh();
      await notify("PIN set", "You can unlock with it after the app locks.");
    } catch (raw) {
      setProblem(asAuthError(raw).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader>Unlock PIN</SectionHeader>
      <p className="text-text-mid max-w-[70ch] text-body leading-relaxed">
        After the app locks itself, a PIN gets you back in without typing your full
        password. It never leaves this machine and the server never sees it — which also
        means it only unlocks, and cannot sign you in somewhere else. It is kept under
        this Windows account, so somebody with the disk but not the account has nothing
        to try it against. Five wrong guesses and only the password will do.
      </p>
      <p className="text-text-mid max-w-[70ch] text-body leading-relaxed">
        A PIN is optional, and this is where it lives. Auto-lock is what protects an
        unattended machine, and it only protects anything if getting back in is quick
        enough that nobody turns it off — which is the whole argument for having one.
        Without it the lock screen asks for your full password instead. Once set, it can
        be changed but not taken away: a lock screen that accepts a PIN somebody has
        forgotten they set is worse than either answer.
      </p>

      {status?.set && !changing ? (
        <div className="flex items-center gap-3">
          <Pill tone="success">PIN set</Pill>
          <span className="text-text-lo text-meta">
            {status.attempts_left} of 5 attempts remaining
          </span>
          {/* Change, not Remove. Setting one is optional; un-setting one is
              not offered, for the reason in the note above. */}
          <Button variant="secondary" disabled={busy} onClick={() => setChanging(true)}>
            Change
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <Field
              label="PIN"
              type="password"
              inputMode="numeric"
              className="w-[160px]"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))}
            />
            <Field
              label="Again"
              type="password"
              inputMode="numeric"
              className="w-[160px]"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 12))}
            />
          </div>
          <div>
            <Button
              variant="primary"
              disabled={pin.length < 4 || busy}
              onClick={() => void save()}
            >
              {busy ? "Setting…" : "Set PIN"}
            </Button>
          </div>
        </div>
      )}

      {problem ? (
        <Callout tone="danger" icon="alert">
          {problem}
        </Callout>
      ) : null}
    </section>
  );
}
