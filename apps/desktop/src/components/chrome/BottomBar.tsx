import { cn } from "../../lib/cn";
import { useApp, type Route } from "../../app/store";
import { Icon } from "../ui/Icon";
import { Panel } from "../ui/Surface";
import { DESTINATIONS, type Destination } from "./destinations";

/**
 * The phone's navigation: five destinations across the bottom.
 *
 * The same list `IconRail` draws down the side, in the same order, so which
 * tab is second does not change when a window is resized or a tablet turned.
 *
 * **Sign-out is not here, and that is the one thing that moved.** On the rail
 * it is safe because it is red only on hover — it spends the hours nobody is
 * near it looking like everything else. A touch screen has no hover, so the
 * same button in a permanent tab bar is a red target in the thumb zone, one
 * mis-tap from Profile beside it, with no intermediate state to warn anybody.
 * It lives in Settings on every width instead.
 *
 * **Labelled, though the references are icons alone.** WhatsApp can draw four
 * unlabelled icons because everybody already knows them. "Home" here is a
 * public feed and "Profile" is a page other people can visit — neither reads
 * off a glyph, and a destination nobody can name is one nobody opens.
 *
 * The bar sits above the home indicator rather than under it:
 * `env(safe-area-inset-bottom)` is added to the padding, with a floor for the
 * phones and browsers that report nothing.
 */
export function BottomBar({ unread }: { unread: Partial<Record<Route, number>> }) {
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);

  return (
    <Panel
      tone="rail"
      edge={false}
      className="shrink-0 border-t border-[var(--hairline)]"
      style={{ paddingBottom: "max(0.375rem, env(safe-area-inset-bottom))" }}
    >
      <nav aria-label="Primary" className="flex items-stretch justify-around pt-1.5">
        {DESTINATIONS.map((destination) => (
          <TabButton
            key={destination.route}
            destination={destination}
            active={route === destination.route}
            unread={unread[destination.route] ?? 0}
            onClick={() => go(destination.route)}
          />
        ))}
      </nav>
    </Panel>
  );
}

function TabButton({
  destination,
  active,
  unread,
  onClick,
}: {
  destination: Destination;
  active: boolean;
  unread: number;
  onClick: () => void;
}) {
  const { icon, label } = destination;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={unread > 0 ? `${label}, ${unread} unread` : label}
      aria-current={active ? "page" : undefined}
      // 56px tall and a fifth of the width: comfortably past the 44px a
      // thumb needs on the narrowest phone (375 / 5 = 75), and the whole cell
      // is the target rather than the glyph.
      className={cn(
        "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-control",
        "transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
        "active:bg-fill-hover",
        active ? "text-accent-soft" : "text-text-lo",
      )}
    >
      <span className="relative">
        <Icon name={icon} size={22} />
        {unread > 0 ? (
          <span className="bg-accent absolute -top-0.5 -right-1 size-1.5 rounded-full" />
        ) : null}
      </span>
      <span className="text-[11px] leading-none font-medium">{label}</span>
    </button>
  );
}
