import type { MenuItem } from "../../components/ui/ContextMenu";

/**
 * What a right-click on a message offers, and in what order (§N7).
 *
 * Pure, and separate from the bubble that draws it, for one reason: the order
 * is a rule rather than an accident of how the code grew. `MenuItem` says
 * destructive entries "always sit last", and this menu is where that is easy
 * to break -- the entries appear and disappear with the message's state, so
 * "last" is different in eight different situations and none of them is
 * visible from the call site. Here it can simply be asserted.
 *
 * The two deletions are the last two, in that order: the one that only touches
 * this device before the one that asks every other device. Escalating, so the
 * heavier of two red entries is never the one the hand lands on first.
 */

/** Everything about a message that changes what the menu offers. */
export interface MessageMenuState {
  /** There is text to copy. An entry that copies "" is worse than no entry. */
  hasBody: boolean;
  /** Ours to edit or take back. */
  mine: boolean;
  /**
   * The name inside the ciphertext, absent on messages sent before names
   * existed. Editing, taking back and reacting all refer to it.
   */
  clientId: string | undefined;
  /** Already taken back: there is nothing left to edit or withdraw. */
  retracted: boolean;
  /** Still inside the ten minutes an edit or a retraction is allowed. */
  withinWindow: boolean;
  /**
   * Queued, so the server has not assigned an envelope id yet -- and that is
   * what a pin and a local delete are keyed by. `state === "sending"` is how
   * the UI already names this.
   */
  queued: boolean;
  /** Pinned on this device, which flips the label rather than adding one. */
  pinned: boolean;
}

/** What each entry does. Kept apart so the order can be tested without them. */
export interface MessageMenuActions {
  reply: () => void;
  copy: () => void;
  forward: () => void;
  edit: () => void;
  react: () => void;
  togglePin: () => void;
  deleteForMe: () => void;
  deleteForEveryone: () => void;
}

export function messageMenuItems(
  state: MessageMenuState,
  actions: MessageMenuActions,
): MenuItem[] {
  const items: MenuItem[] = [];

  // First, because it is what somebody most often came to the menu for.
  //
  // Needs the name inside the ciphertext, like reacting does: a reply refers to
  // its target by that name, so a message sent before names existed cannot be
  // answered and the entry is absent rather than shown and refused. A retracted
  // message is not offered either -- there is nothing left to answer.
  if (state.clientId && !state.retracted && !state.queued) {
    items.push({ label: "Reply", icon: "send", onSelect: actions.reply });
  }

  if (state.hasBody) {
    items.push({ label: "Copy text", icon: "file", onSelect: actions.copy });
    // Only what has words. Forwarding is a re-encryption of the text into
    // another group; an attachment would mean deciding who owns the object in
    // the bucket afterwards, which is a question with no answer yet, so the
    // entry is absent rather than offered and refused.
    if (!state.retracted && !state.queued) {
      items.push({ label: "Forward…", icon: "send", onSelect: actions.forward });
    }
  }

  // Only ours, only while the window is open, and only if the message has a
  // name to refer to. The entry is **absent** past ten minutes rather than
  // greyed out: an action that is gone was never offered, while a disabled one
  // invites the question of how to get it back.
  const revisable =
    state.mine && !!state.clientId && !state.retracted && state.withinWindow;
  if (revisable) {
    items.push({ label: "Edit", icon: "file", onSelect: actions.edit });
  }

  // Reacting needs the name inside the ciphertext, which a message sent before
  // names existed does not have. Absent there rather than shown and refused.
  if (state.clientId) {
    items.push({ label: "React", icon: "emoji", onSelect: actions.react });
  }

  if (!state.queued) {
    items.push({
      // Named for what it is. "Pin" alone would imply everyone sees it.
      label: state.pinned ? "Unpin from this device" : "Pin on this device",
      icon: "shield",
      onSelect: actions.togglePin,
    });
  }

  // The last two, always, and in this order.
  if (!state.queued) {
    items.push({
      label: "Delete for me",
      icon: "close",
      danger: true,
      onSelect: actions.deleteForMe,
    });
  }
  if (revisable) {
    items.push({
      label: "Delete for everyone",
      icon: "close",
      danger: true,
      onSelect: actions.deleteForEveryone,
    });
  }

  return items;
}
