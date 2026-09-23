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
 * `Session.logout` in `packages/core` wipes the store in a `finally`, after
 * asking the server to end the session, so a failure from the server arrives
 * when the data is already gone. Staying on a screen that has no session
 * behind it would be the lie, not the fix.
 */
export function useSignOut(): { signOut: () => Promise<void>; busy: boolean } {
  const setAccount = useApp((s) => s.setAccount);
  const [busy, setBusy] = useState(false);

  const signOut = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await confirm(
        "Sign out",
        "This signs this device out and deletes your message history on it. The server does not keep delivered messages, so it cannot be restored here.",
      );
      if (!ok) return;
      try {
        await logout();
      } catch {
        // See above: the disk is already wiped.
      }
      // The answer to the PIN offer is *not* reset here, and that is the whole
      // point of it.
      //
      // Signing out erases the PIN with the rest of the store, so
      // `pinStatus` honestly reports "no PIN" afterwards -- and re-arming the
      // offer on top of that put "Choose an unlock PIN" in front of the very
      // next sign-in, which is the thing the offer was made skippable to stop
      // doing. Being asked once is a feature being introduced; being asked
      // again every time you sign out and back in is a toll gate wearing a
      // Not now button. Somebody who wants a PIN after this sets one in
      // Settings, where it has lived all along.
      setAccount(null);
    } finally {
      setBusy(false);
    }
  }, [busy, setAccount]);

  return { signOut, busy };
}
