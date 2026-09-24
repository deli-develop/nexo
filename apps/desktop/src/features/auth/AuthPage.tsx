import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Controls";
import { Callout } from "../../components/ui/Feedback";
import {
  asAuthError,
  handleProblem,
  login,
  register,
  type Account,
  keptAccount,
} from "../../lib/auth";

type Mode = "login" | "register";

/**
 * The one screen you can reach without an account (§4.1).
 *
 * Two things this screen is careful about:
 *
 * **It never says whether a handle exists.** The server goes to some trouble
 * to make an unknown handle indistinguishable from a known one — a wrong
 * password and a nonexistent account produce the same refusal — and a UI that
 * rendered them differently would give the whole thing away.
 *
 * **It tells the truth about what registration costs.** One device, one
 * account, and no recovery: losing the machine loses the history, because the
 * server holds no key that could bring it back. That is the correct security
 * posture and a permanent support burden, so it is said here, before the
 * account exists, rather than discovered later (PLAN.md risk 7).
 */
export function AuthPage({
  onSignedIn,
  endedFor,
}: {
  onSignedIn: (a: Account) => void;
  /**
   * The handle whose session the server just ended on this device -- nearly
   * always a sign-in somewhere else. Said, rather than dropping somebody on a
   * blank form mid-conversation.
   */
  endedFor?: string;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [handle, setHandle] = useState(endedFor ?? "");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whose history this device kept when they signed out. Their handle is
  // filled in -- signing back in is what almost everybody here is doing --
  // and anybody else is told, before they press anything, that signing in
  // replaces it.
  const [kept, setKept] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void keptAccount().then((found) => {
      if (cancelled || !found) return;
      setKept(found);
      setHandle((typed) => typed || found);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const replacesKept = kept !== null && (mode === "register" || (handle !== "" && handle !== kept));

  const handleError = handleProblem(handle);
  const canSubmit =
    handle.length > 0 &&
    !handleError &&
    password.length > 0 &&
    (mode === "login" || displayName.trim().length > 0) &&
    !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const account =
        mode === "register"
          ? await register(handle, displayName.trim(), password)
          : await login(handle, password);
      // Drop the password from component state the moment it is no longer
      // needed. It cannot be un-typed from memory, but it should not sit in a
      // React state cell for the rest of the session either.
      setPassword("");
      onSignedIn(account);
    } catch (raw) {
      const e = asAuthError(raw);
      setError(e.message);
      // Only the password is cleared on failure. Retyping a handle you got
      // right is a small, pointless punishment.
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setPassword("");
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <form
        onSubmit={submit}
        className="border-line bg-surface-1 w-full max-w-[380px] rounded-panel border p-6 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.7)]"
      >
        <h1 className="text-text-hi font-display text-[22px] leading-tight font-medium">
          {mode === "login" ? "Sign in to Nexo" : "Create your account"}
        </h1>
        <p className="text-text-lo mt-1.5 text-meta">
          {mode === "login"
            ? "Your handle and password."
            : "Pick a handle. It is how people find you."}
        </p>

        <div className="mt-5 flex flex-col gap-3.5">
          <Field
            label="Handle"
            value={handle}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            placeholder="alice"
            onChange={(e) => setHandle(e.target.value.toLowerCase())}
            {...(handleError ? { error: handleError } : {})}
            {...(mode === "register" && !handleError
              ? { hint: "Lowercase letters, digits and underscores. 3–20 characters." }
              : {})}
          />

          {mode === "register" ? (
            <Field
              label="Display name"
              value={displayName}
              placeholder="Alice"
              autoComplete="name"
              onChange={(e) => setDisplayName(e.target.value)}
              hint="What people see. You can change this later."
            />
          ) : null}

          <Field
            label="Password"
            type="password"
            value={password}
            autoComplete={
              mode === "register" ? "new-password" : "current-password"
            }
            onChange={(e) => setPassword(e.target.value)}
            {...(mode === "register"
              ? { hint: "Choose something long. There is no way to reset it." }
              : {})}
          />
        </div>

        {endedFor && mode === "login" && !error ? (
          <Callout tone="warning" icon="alert" className="mt-4">
            Your session on this device has ended — usually because
            @{endedFor} signed in somewhere else, in the web app or on another
            computer. Nexo keeps one device signed in per account. Signing in
            here again brings back what this device already has, and signs the
            other one out.
          </Callout>
        ) : null}

        {replacesKept && !error ? (
          <Callout tone="warning" icon="alert" className="mt-4">
            This device keeps @{kept}'s messages. Signing in as anybody else
            removes them from it — they cannot be brought back here.
          </Callout>
        ) : kept !== null && handle === kept && mode === "login" && !endedFor && !error ? (
          <Callout className="mt-4">
            Your messages are still on this device. Signing in picks up where
            you left off.
          </Callout>
        ) : null}

        {error ? (
          <Callout tone="danger" icon="alert" className="mt-4">
            {error}
          </Callout>
        ) : null}

        {mode === "register" ? (
          <Callout tone="warning" icon="alert" className="mt-4">
            One device, one account, and no recovery. If you lose this machine
            or forget this password, the account and its history are gone — the
            server holds no key that can bring them back.
          </Callout>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          disabled={!canSubmit}
          className="mt-5 h-10 w-full"
        >
          {busy
            ? mode === "register"
              ? "Creating account…"
              : "Signing in…"
            : mode === "register"
              ? "Create account"
              : "Sign in"}
        </Button>

        <p className="text-text-lo mt-4 text-center text-meta">
          {mode === "login" ? "No account yet?" : "Already have an account?"}{" "}
          <button
            type="button"
            className="text-accent-soft hover:underline"
            onClick={() => switchMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "Create one" : "Sign in"}
          </button>
        </p>
      </form>
    </div>
  );
}
