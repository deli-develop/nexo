import type { Route } from "../../app/store";
import type { IconName } from "../ui/Icon";

/**
 * The five destinations, in the order both navigations draw them.
 *
 * One array, two shapes: a 64px rail down the left at 768px and up, a tab bar
 * across the bottom below that. `IconRail.tsx`'s header promised this would be
 * a layout change rather than a rewrite, and this file is what keeps that
 * promise — neither component decides what the destinations *are*.
 *
 * Order is deliberate and shared. Muscle memory for "Messages is second"
 * should survive rotating a tablet or resizing a window, and it only can if
 * both navigations read the same list.
 */
export interface Destination {
  route: Route;
  icon: IconName;
  label: string;
}

export const DESTINATIONS: Destination[] = [
  { route: "home", icon: "home", label: "Home" },
  { route: "messages", icon: "messages", label: "Messages" },
  // Beside Messages because it is the other private place, and after it
  // because Messages stays second -- the muscle memory this order protects.
  { route: "teams", icon: "team", label: "Teams" },
  { route: "profile", icon: "user", label: "Profile" },
  { route: "settings", icon: "settings", label: "Settings" },
];
