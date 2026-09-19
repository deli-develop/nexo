import { useEffect } from "react";

import { lockCore } from "../lib/native";
import { useApp } from "./store";

/**
 * Auto-lock (§8): after N minutes without input, the app locks.
 *
 * The timer lives here, in the WebView, because idleness means "no keyboard
 * or pointer activity" and the window is the only place that is observable.
 * The locking itself happens in Rust — `lock` drops the SQLCipher connection
 * and the MLS state — and the WebView's part ends at reporting that the time
 * has come. See `lock.rs` for what locking does and does not guarantee.
 *
 * Activity is sampled, not handled: writing a timestamp on every mousemove is
 * cheap, but going through React state would re-render on every pixel, so the
 * timestamp lives in a plain variable and an interval compares it.
 */

/** How often the deadline is checked. Sets the precision of "N minutes". */
const CHECK_EVERY_MS = 15_000;

const TIMEOUT_MS: Record<string, number | null> = {
  never: null,
  "5": 5 * 60_000,
  "15": 15 * 60_000,
  "60": 60 * 60_000,
};

export function useAutoLock(): void {
  const timeout = useApp((s) => s.preferences.lockTimeout);
  const signedIn = useApp((s) => s.account !== null);
  const locked = useApp((s) => s.locked);

  useEffect(() => {
    const limit = TIMEOUT_MS[timeout];
    if (!signedIn || locked || limit == null) return;

    let lastActivity = Date.now();
    const bump = () => {
      lastActivity = Date.now();
    };

    // Everything a hand does. `keydown` rather than `keypress`: modifiers are
    // activity too, and someone alt-tabbing through windows is present.
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, bump, { passive: true });

    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity < limit) return;
      // Rust locks first, then the UI follows. The other order would draw a
      // lock screen over an app that is still open underneath.
      void lockCore().then(() => {
        useApp.getState().setLocked(true);
      });
    }, CHECK_EVERY_MS);

    return () => {
      window.clearInterval(timer);
      for (const name of events) window.removeEventListener(name, bump);
    };
  }, [timeout, signedIn, locked]);
}
