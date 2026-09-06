import { useCallback, useState } from "react";

import { useApp } from "../../app/store";
import { logout } from "../../lib/auth";
import { confirm } from "../../lib/native";

/**
 * Signing out, in one place because it was in two and they had drifted.
 *
 * The rail's button held a `busy` flag and the profile's did not, so the same
 * action behaved differently depending on where it was pressed — and only one
 * of them was protected against the failure below.
 *
 * # Why `busy` covers the question, not just the answer
 *
 * The confirmation is an in-app modal (`lib/dialogs.ts`) and modals **queue**
 * rather than stack: a second click while one is open puts another behind it,
 * and each has to be answered before anything happens. If the dialog is hard
 * to see — which it was, when the depth slider took the surface colours out
 * from under it — pressing the button again is the natural thing to do, and it
 * made the situation worse instead of better. So the flag goes up before the
 * question is asked and comes down in `finally`, whatever the answer was.
 *
 * # Why a failed sign-out still returns to the sign-in screen
 *
 * Rust deletes the store and its key before it reports anything, and it
 * surfaces a server-side failure only afterwards (`session::logout`). By the
 * time an error reaches here the data is gone, so staying on a screen that has
 * no session behind it would be the lie, not the fix.
 */
export function useSignOut(): { signOut: () => Promise<void>; busy: boolean } {
  const setAccount = useApp((s) => s.setAccount);
  const setPreference = useApp((s) => s.setPreference);
  const [busy, setBusy] = useState(false);

  const signOut = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await confirm(
        "Sign out",
        "This signs this device out and deletes its local message store. Anything not synced is gone.",
      );
      if (!ok) return;
      try {
        await logout();
      } catch {
        // See above: the disk is already wiped.
      }
      // The PIN went with the store it unwrapped, so the answer somebody gave
      // to the PIN offer went with it too. The next person to sign in on this
      // machine has not been asked anything yet.
      setPreference("pinOfferAnswered", false);
      setAccount(null);
    } finally {
      setBusy(false);
    }
  }, [busy, setAccount, setPreference]);

  return { signOut, busy };
}
