import { useEffect } from "react";

import { layoutNow } from "./useLayout";
import { useApp } from "./store";

/**
 * The keyboard, in one place.
 *
 * Desktop users lean on a handful of chords without ever calling them a
 * feature, and the cost of not having them is paid every day rather than
 * noticed once. These are the ones every desktop messenger agrees on, so they
 * are the ones nobody has to learn.
 *
 * # Why one listener rather than one per component
 *
 * A chord is global by nature: `Ctrl+F` means "find" wherever the focus
 * happens to be. Spreading them across the components that act on them means
 * two surfaces can quietly claim the same chord and whichever mounted last
 * wins — a bug that only appears on one route. Here the whole set can be read
 * at once, and a collision is visible in the same screen of code.
 *
 * # Why every chord here holds a modifier
 *
 * A bare letter cannot be a shortcut in an app whose main control is a text
 * box — it would fire mid-word. So the set is deliberately `Ctrl`-based, and
 * `Esc`, which means the same thing everywhere: undo the last thing that
 * opened. `Esc` is claimed here only for what this owns; a menu, a modal or a
 * picker handles its own and stops the event before it arrives.
 */

/**
 * @param conversationIds The list in the order it is shown, so stepping moves
 *   the way the eye does. Passed in rather than read from a store copy: the
 *   shell already holds the one live list, and a second ordered copy kept in
 *   sync is the bug this app has already had once.
 */
export function useShortcuts(conversationIds: string[]): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const state = useApp.getState();
      const mod = event.ctrlKey || event.metaKey;

      // Find, in the conversation you are looking at. Claimed even while
      // typing, because that is where a hand already is when it wants it.
      if (mod && event.key.toLowerCase() === "f") {
        if (state.route !== "messages" || !state.activeConversationId) return;
        event.preventDefault();
        state.setConversationSearch(true);
        return;
      }

      // Between conversations, in the order the list shows them. Ctrl+Tab is
      // the browser's own chord for the same idea and the one people try.
      if (mod && event.key === "Tab") {
        if (state.route !== "messages" || conversationIds.length === 0) return;
        event.preventDefault();
        const here = conversationIds.indexOf(state.activeConversationId ?? "");
        const by = event.shiftKey ? -1 : 1;
        // From nowhere, Ctrl+Tab lands on the first and Ctrl+Shift+Tab on the
        // last, so both do something on a screen with nothing selected.
        const next =
          here === -1
            ? by > 0
              ? 0
              : conversationIds.length - 1
            : (here + by + conversationIds.length) % conversationIds.length;
        state.openConversation(conversationIds[next]!);
        return;
      }

      if (event.key === "Escape") {
        // Only what this owns, and only when nothing nearer has taken it: a
        // menu, a modal or a picker handles its own Escape and stops the event
        // before it arrives here.
        if (state.conversationSearchOpen) {
          event.preventDefault();
          state.setConversationSearch(false);
          return;
        }
        // Back to the list, where the list is not already beside you. On a
        // desktop the conversation stays open, because Escape closing it would
        // mean losing your place for a keypress that had no target.
        if (state.activeConversationId && !layoutNow().canShowList) {
          event.preventDefault();
          state.closeConversation();
        }
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [conversationIds]);
}
