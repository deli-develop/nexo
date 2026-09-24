import type { MenuItem } from "../../components/ui/ContextMenu";

/**
 * What a team post's or comment's menu offers, and in what order.
 *
 * Pure for the reason `features/messages/menu.ts` is: destructive entries sit
 * last, and whether that holds depends on who is looking and what state the
 * post is in -- which is easy to break and easy to assert.
 *
 * Two red entries at most, escalating: the author's own take-back before an
 * admin's removal, so the heavier of the two is never the first under the
 * hand. Both are requests other Nexo installations honour, and the dialogs
 * that follow say so.
 */

export interface PostMenuState {
  /** There are words to copy. */
  hasBody: boolean;
  /** This device wrote it. */
  mine: boolean;
  /** Still inside the window an edit or a take-back is allowed. */
  withinWindow: boolean;
  /** Already taken back or removed: nothing left to act on. */
  gone: boolean;
  /** The viewer is the team's owner or an admin. */
  moderates: boolean;
  /** A post can be pinned; a comment cannot. */
  pinnable: boolean;
  pinned: boolean;
}

export interface PostMenuActions {
  copy: () => void;
  edit: () => void;
  react: () => void;
  togglePin: () => void;
  takeBack: () => void;
  removeForEveryone: () => void;
}

export function postMenuItems(state: PostMenuState, actions: PostMenuActions): MenuItem[] {
  if (state.gone) return [];
  const items: MenuItem[] = [];

  if (state.hasBody) items.push({ label: "Copy text", icon: "copy", onSelect: actions.copy });

  const revisable = state.mine && state.withinWindow;
  if (revisable) items.push({ label: "Edit", icon: "pencil", onSelect: actions.edit });

  items.push({ label: "React", icon: "emoji", onSelect: actions.react });

  if (state.pinnable && state.moderates) {
    items.push({
      // "for everyone", because unlike a pinned message this is not a
      // device-local choice: every member sees it on top.
      label: state.pinned ? "Unpin for everyone" : "Pin for everyone",
      icon: "pin",
      onSelect: actions.togglePin,
    });
  }

  if (revisable) {
    items.push({ label: "Take back", icon: "close", danger: true, onSelect: actions.takeBack });
  }
  // Last: the heaviest thing anybody can do to somebody else's words.
  if (state.moderates && !state.mine) {
    items.push({
      label: "Remove for everyone",
      icon: "trash",
      danger: true,
      onSelect: actions.removeForEveryone,
    });
  }
  return items;
}
