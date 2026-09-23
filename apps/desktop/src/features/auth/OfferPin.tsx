import { useState } from "react";

import { asAuthError, setPin as setPinCall, type Account } from "../../lib/auth";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Controls";
import { Callout } from "../../components/ui/Feedback";
import { Panel } from "../../components/ui/Surface";

/**
 * The unlock PIN, offered once after signing in.
 *
 * # Why it is offered and not required
 *
 * It used to be a gate: the app would not open until a PIN existed. The
 * argument was that auto-lock only protects an unattended machine if getting
 * back in is quick, so people who have to retype a whole password lengthen the
 * timer or switch it off — and a cheap way back in is what keeps the expensive
 * protection switched on.
 *
 * That argument is still right about auto-lock. It was wrong about where to
 * spend it. Standing between somebody and their own messages, at every sign-in,
 * is too much to charge for a convenience — and it charged it hardest exactly
 * when things had already gone wrong, since signing out erases the PIN, so the
 * sign-in that followed a sign-out was met by the same wall again. The
 * discovery it was buying is worth one screen, not a toll gate: the offer is
 * made once per machine, either answer is final, and Settings keeps it
 * available afterwards.
 *
 * # What it is not
 *
 * Not a second factor, and not a secret the server has heard of. It only ever
 * resumes a session this device already holds, and it guards the screen, not
 * the disk: the store is unencrypted IndexedDB, so somebody who can read this
 * machine's files does not need the PIN at all. This component deliberately
 * does not imply more.
 *
 * # Why it replaces the shell rather than covering it
 *
 * The same rule as `LockScreen`: nothing readable may sit in the DOM behind a
 * screen that is standing in for the app. It is drawn *instead of* the shell,
 * so there is no conversation underneath to reach with a screen reader or a
 * stray tab press.
 */
export function OfferPin({
  account,
  onSet,
  onSkip,
}: {
  account: Account;
  onSet: () => void;
  onSkip: () => void;
}) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const short = pin.length < 4;
  const mismatch = again.length > 0 && pin !== again;

  async function save() {
    if (short || pin !== again || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await setPinCall(pin);
      onSet();
    } catch (raw) {
      setProblem(asAuthError(raw).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-8">
      <Panel tone="raised" className="w-full max-w-[420px] rounded-panel border border-line p-6">
        <h1 className="text-text-hi font-display text-[22px] leading-tight font-semibold">
          Choose an unlock PIN
        </h1>
        <p className="text-text-mid mt-2 text-body leading-relaxed">
          Nexo locks itself when you leave it. The PIN is how you get back in without
          typing your whole password, {account.display_name}. You can skip this and set
          one later in Settings — without one, the lock screen asks for your password.
        </p>

        <Callout tone="neutral" icon="shield">
          It never leaves this machine and the server never sees it, so it only unlocks —
          it cannot sign you in anywhere else. Four digits or more, and five wrong
          guesses fall back to your password.
        </Callout>

        <div className="mt-4 flex flex-wrap gap-3">
          <Field
            label="PIN"
            type="password"
            inputMode="numeric"
            autoFocus
            className="w-[160px]"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))}
          />
          <Field
            label="Again"
            type="password"
            inputMode="numeric"
            className="w-[160px]"
            value={again}
            onChange={(e) => setAgain(e.target.value.replace(/\D/g, "").slice(0, 12))}
            {...(mismatch ? { error: "Those two are not the same." } : {})}
          />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="primary"
            disabled={short || pin !== again || busy}
            onClick={() => void save()}
          >
            {busy ? "Setting…" : "Set PIN and continue"}
          </Button>
          {/* A real way past, not a smaller gate. The offer is made once, so
              this answer has to be as final as the other one. */}
          <Button variant="secondary" disabled={busy} onClick={onSkip}>
            Not now
          </Button>
        </div>

        {problem ? (
          <div className="mt-3">
            <Callout tone="danger" icon="alert">
              {problem}
            </Callout>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
