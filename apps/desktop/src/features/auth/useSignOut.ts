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
 * # What stays on the device
 *
 * By default, everything but the session: the keys, the conversations and
 * their history, the unlock PIN. Signing in again as the same person brings
 * all of it back, where it used to start from nothing -- every chat had to be
 * begun again, and what had been said was gone. The question says so, and
 * says who else could read it, because "sign out" alone reads as "nothing of
 * mine is left here".
 *
 * `erase` is the other answer, for a computer somebody else will use. It is
 * offered in Settings, where there is room to say what it costs.
 *
 * # Why a failed sign-out still returns to the sign-in screen
 *
 * `Session.logout` in `packages/core` does its local half in a `finally`,
 * after asking the server to end the session, so a failure from the server
 * arrives when this device has already let go. Staying on a screen that has
 * no session behind it would be the lie, not the fix.
 */
export function useSignOut(): {
  signOut: (options?: { erase?: boolean }) => Promise<void>;
  busy: boolean;
} {
  const setAccount = useApp((s) => s.setAccount);
  const [busy, setBusy] = useState(false);

  const signOut = useCallback(
    async (options: { erase?: boolean } = {}) => {
      if (busy) return;
      setBusy(true);
      try {
        const ok = options.erase
          ? await confirm(
              "Sign out and erase this device",
              "This signs you out and deletes everything Nexo keeps here: your messages, your keys and the unlock PIN. Nothing on this device can read those conversations again — signing in later starts them from nothing.",
            )
          : await confirm(
              "Sign out",
              "Your messages stay on this device, so they are here when you sign in again. They are not encrypted on the disk: anybody who uses this computer can read them. On a shared computer, use Sign out and erase in Settings.",
            );
        if (!ok) return;
        try {
          await logout(options);
        } catch {
          // See above: this device has already let go.
        }
        // The answer to the PIN offer is *not* reset here. Somebody who wants
        // a PIN after this sets one in Settings, where it has lived all
        // along; being asked again at every sign-in is a toll gate wearing a
        // Not now button.
        setAccount(null);
      } finally {
        setBusy(false);
      }
    },
    [busy, setAccount],
  );

  return { signOut, busy };
}
