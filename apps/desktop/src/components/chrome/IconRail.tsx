
import { cn } from "../../lib/cn";
import { useApp, type Route } from "../../app/store";
import { useSignOut } from "../../features/auth/useSignOut";
import { Icon, type IconName } from "../ui/Icon";
import { Panel } from "../ui/Surface";

const destinations: { route: Route; icon: IconName; label: string }[] = [
  { route: "home", icon: "home", label: "Home" },
  { route: "messages", icon: "messages", label: "Messages" },
  { route: "profile", icon: "user", label: "Profile" },
];

/**
 * The 64px rail (§7.3).
 *
 * Deliberately the quietest thing in the window. The references keep it to
 * plain icons at one weight — the active one is simply brighter, with a short
 * accent bar on the window edge. A tinted pill behind every state and a
 * counter badge on top of it turns four destinations into the loudest element
 * on screen, which is backwards.
 *
 * On Android this becomes a bottom tab bar (§12). Keeping the destinations in
 * one array is what makes that a layout change rather than a rewrite.
 */
export function IconRail({ unread }: { unread: number }) {
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);

  return (
    <Panel
      tone="rail"
      edge={false}
      className="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-[var(--hairline)] py-4"
    >
      <nav aria-label="Primary" className="flex flex-col items-center gap-2">
        {destinations.map((destination) => (
          <RailButton
            key={destination.route}
            {...destination}
            active={route === destination.route}
            dot={destination.route === "messages" && unread > 0}
            unread={destination.route === "messages" ? unread : 0}
            onClick={() => go(destination.route)}
          />
        ))}
      </nav>

      <div className="flex-1" />

      <RailButton
        route="settings"
        icon="settings"
        label="Settings"
        active={route === "settings"}
        dot={false}
        unread={0}
        onClick={() => go("settings")}
      />

      <SignOutButton />
    </Panel>
  );
}

/**
 * Signing out, where it can always be reached.
 *
 * Not in a menu and not on a page you have to navigate to first: the rail is
 * visible from every destination, which is what "always available" has to mean
 * for the one action someone reaches for when they want to stop being signed
 * in on a machine.
 *
 * Red only on hover. A destructive action that is red at rest is red for the
 * hours nobody is going near it, and the colour stops meaning anything.
 */
function SignOutButton() {
  const { signOut, busy } = useSignOut();

  return (
    <button
      type="button"
      onClick={() => void signOut()}
      disabled={busy}
      aria-label="Sign out"
      title="Sign out"
      className="text-text-lo hover:text-danger relative flex size-11 items-center justify-center rounded-control transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)] hover:bg-danger/10"
    >
      <Icon name="logout" size={20} />
    </button>
  );
}

function RailButton({
  icon,
  label,
  active,
  dot,
  unread,
  onClick,
}: {
  route: Route;
  icon: IconName;
  label: string;
  active: boolean;
  dot: boolean;
  unread: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dot ? `${label}, ${unread} unread` : label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-control transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
        active ? "text-accent-soft" : "text-text-lo hover:text-text-mid",
      )}
    >
      {active ? (
        <span className="bg-accent absolute top-1/2 -left-[18px] h-5 w-[3px] -translate-y-1/2 rounded-r-full" />
      ) : null}
      <Icon name={icon} size={20} />
      {dot ? (
        <span className="bg-accent absolute top-2.5 right-2.5 size-1.5 rounded-full" />
      ) : null}
    </button>
  );
}
