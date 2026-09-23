import { useEffect, useState } from "react";
import { useApp } from "../../app/store";
import { Button } from "../../components/ui/Button";
import { FactRow, Field, Toggle } from "../../components/ui/Controls";
import { Callout } from "../../components/ui/Feedback";
import {
  getRelayInfo,
  getViaRelay,
  setViaRelay,
  startRelay,
  stopRelay,
} from "../../lib/native";
import { inTauri } from "../../lib/runtime";

/**
 * Connecting through somebody's relay: the blocked user's half
 * (`src-tauri/src/via_relay.rs`).
 *
 * Saving restarts the app, because the WebView's proxy is fixed when it is
 * made. So the field is a draft until Save, and the row above it says what is
 * in force now, not what has been typed.
 */
export function ViaRelay() {
  const desktop = inTauri();
  const [current, setCurrent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getViaRelay().then((address) => {
      if (cancelled) return;
      setCurrent(address);
      setDraft(address ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Success restarts the app, so this only ever comes back with a refusal.
  async function apply(address: string | null) {
    setBusy(true);
    setError(null);
    try {
      await setViaRelay(address);
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "Couldn't save the relay.");
      setBusy(false);
    }
  }

  if (!desktop) {
    return (
      <p className="text-text-mid py-3 text-meta">
        Only the desktop app can connect through a relay. A browser tab cannot choose where its
        connections go.
      </p>
    );
  }

  const typed = draft.trim();
  return (
    <div className="flex flex-col gap-3 py-3">
      <FactRow icon="globe" label="Connecting">
        {current ? <span className="font-mono">through {current}</span> : "directly"}
      </FactRow>
      <div className="grid max-w-[420px] gap-3">
        <Field
          label="Relay address"
          placeholder="relay.example.org:41731"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typed !== "" && typed !== current) void apply(typed);
          }}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          hint="The address and port the person running it gave you."
          {...(error ? { error } : {})}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy || typed === "" || typed === current}
          onClick={() => void apply(typed)}
        >
          Save and restart
        </Button>
        {current ? (
          <Button variant="ghost" disabled={busy} onClick={() => void apply(null)}>
            Connect directly
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const PORT_MIN = 1024;
const PORT_MAX = 65535;

/**
 * Relaying for other people: the volunteer's half (`src-tauri/src/relay.rs`).
 *
 * The preference says whether it should run, and the shell says whether it
 * does. They can disagree — a port something else holds — and this draws the
 * shell's answer, so a relay that failed to open is never shown as running.
 * `App` starts it at launch when the preference is on.
 */
export function RunRelay() {
  const desktop = inTauri();
  const on = useApp((s) => s.preferences.relay);
  const port = useApp((s) => s.preferences.relayPort);
  const set = useApp((s) => s.setPreference);
  const [running, setRunning] = useState<number | null>(null);
  const [portDraft, setPortDraft] = useState(String(port));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getRelayInfo().then((info) => {
      if (!cancelled) setRunning(info?.port ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function start(at: number) {
    const info = await startRelay(at);
    setRunning(info?.port ?? null);
    if (!info) {
      setError(
        `Couldn't open port ${at}. Something else on this computer may be using it — try another.`,
      );
    }
  }

  async function turn(next: boolean) {
    setError(null);
    set("relay", next);
    if (next) {
      await start(port);
    } else {
      await stopRelay();
      setRunning(null);
    }
  }

  async function commitPort() {
    const next = Number(portDraft.trim());
    if (next === port) return;
    if (!Number.isInteger(next) || next < PORT_MIN || next > PORT_MAX) {
      setError(`Use a port from ${PORT_MIN} to ${PORT_MAX}.`);
      return;
    }
    setError(null);
    set("relayPort", next);
    // A running relay answers `startRelay` with itself, so a new port means
    // stopping the old one first.
    if (on) {
      await stopRelay();
      await start(next);
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-1 pb-3">
      <Toggle
        checked={desktop && on}
        disabled={!desktop}
        onChange={(next) => void turn(next)}
        label="Relay for others"
        description={
          desktop
            ? "Uses your internet connection and keeps a port open while Nexo is running."
            : "Only the desktop app can relay."
        }
      />
      {desktop ? (
        <div className="grid max-w-[200px] gap-3">
          <Field
            label="Port"
            inputMode="numeric"
            value={portDraft}
            onChange={(e) => setPortDraft(e.target.value)}
            onBlur={() => void commitPort()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitPort();
            }}
            hint={`${PORT_MIN}–${PORT_MAX}.`}
            {...(error ? { error } : {})}
          />
        </div>
      ) : null}
      {running !== null ? (
        <Callout icon="globe" title={`Relaying on port ${running}.`}>
          Give people this computer's public address with :{running} after it. Behind a home
          router, forward port {running} to this computer first, or nobody outside can reach it.
          If Windows asks whether Nexo may accept connections, allow it.
        </Callout>
      ) : null}
      <Callout tone="warning" icon="alert" title="Where you are matters.">
        What passes through is unreadable to you, but that your computer carries traffic to Nexo is
        not hidden. If Nexo is blocked where you live, running a relay can be noticed. Relays help
        most from outside the countries doing the blocking.
      </Callout>
    </div>
  );
}
