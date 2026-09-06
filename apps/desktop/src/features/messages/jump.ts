/**
 * Landing on one message in a wall of them.
 *
 * Shared because two things now do it — following a quote back to what it
 * quoted, and stepping through search results — and they have to land the same
 * way. A jump that scrolls silently in one place and flashes in the other
 * reads as two different features.
 *
 * The rows carry `data-envelope-id`, so this asks the document rather than
 * threading a ref down through the list. That is the one place a query
 * selector is the right tool here: the target is whatever is rendered, and the
 * caller does not know which page of history that is on.
 */

/** How long the landing mark stays, in milliseconds. */
const FLASH_MS = 1200;

/**
 * Scrolls the message with this envelope id into view and marks where you
 * landed.
 *
 * Returns whether it found one, so a caller stepping through results can tell
 * the difference between "moved" and "that message is not loaded".
 *
 * The mark is removed on a timer rather than by state, so jumping to the same
 * message twice re-triggers it instead of being coalesced away.
 */
export function jumpToMessage(envelopeId: number): boolean {
  const el = document.querySelector<HTMLElement>(
    `[data-envelope-id="${envelopeId}"]`,
  );
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("quote-landed");
  // Forces the class to be re-applied rather than coalesced away.
  void el.offsetWidth;
  el.classList.add("quote-landed");
  window.setTimeout(() => el.classList.remove("quote-landed"), FLASH_MS);
  return true;
}
