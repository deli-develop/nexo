import { cn } from "../../lib/cn";
import { useApp, type Route } from "../../app/store";
import { useSignOut } from "../../features/auth/useSignOut";
import { Avatar } from "../ui/Avatar";
import { Icon, type IconName } from "../ui/Icon";
import { RemoteImage } from "../ui/RemoteImage";
import { Panel } from "../ui/Surface";
import { DESTINATIONS, type Destination } from "./destinations";

/**
 * The 64px rail, at 768px and up (§7.3).
 *
 * Drawn in the same vocabulary as every other button in the window: flat,
 * no shadow, a soft fill under the pointer, and the one you are on tinted in
 * the accent -- the same "on" the context panel's toggle and the bottom bar's
 * current tab wear. It was a column of raised white discs with drop shadows,
 * the current one inverted to solid black, and it was the only thing in the
 * app built that way: it sat on the window rather than in it.
 *
 * Three groups, top to bottom. The mark, which is drawn in `TopBar`'s cell
 * above this column and takes you Home. The run of destinations you look at,
 * centred in the column. And at the foot, the things about *you*: Settings,
 * sign-out, and your own face, which is how you get to your profile.
 *
 * **Profile is at the foot here, and third in the bottom bar.** It moved for
 * the same reason Settings did: the run is where you go to look at something,
 * the foot is where you go to change yourself or the app. It is drawn as your
 * avatar rather than a generic person glyph, because on a rail with room for
 * one picture the picture that answers "who am I signed in as" is worth more
 * than a second silhouette. Messages is still second in both navigations,
 * which is the muscle memory `destinations.ts` exists to protect.
 *
 * Below 768px `BottomBar` draws the same list across the bottom instead. That
 * this is a layout change rather than a rewrite is what the shared
 * `destinations.ts` buys.
 */
export function IconRail({ unread }: { unread: Partial<Record<Route, number>> }) {
  const route = useApp((s) => s.route);
  const viewingHandle = useApp((s) => s.viewingHandle);
  const go = useApp((s) => s.go);

  const run = DESTINATIONS.filter((d) => !FOOT.has(d.route));
  const settings = destination("settings");
  const profile = destination("profile");

  return (
    <Panel
      tone="rail"
      edge={false}
      className="flex w-16 shrink-0 flex-col items-center border-r border-[var(--hairline)] py-4"
    >
      <div className="flex-1" />

      <nav aria-label="Primary" className="flex flex-col items-center gap-2">
        {run.map((d) => (
          <RailButton
            key={d.route}
            {...d}
            active={route === d.route}
            unread={unread[d.route] ?? 0}
            onClick={() => go(d.route)}
          />
        ))}
      </nav>

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-2">
        <RailButton
          {...settings}
          active={route === "settings"}
          unread={0}
          onClick={() => go("settings")}
        />
        <SignOutButton />
        {/* Only your own profile lights it. Someone else's is also the
            "profile" route, and your face lit up while you read theirs would
            say you were looking at yourself. */}
        <ProfileButton
          label={profile.label}
          active={route === "profile" && viewingHandle === null}
          onClick={() => go("profile")}
        />
      </div>
    </Panel>
  );
}

/** Drawn at the foot of the rail rather than in the run. See the header. */
const FOOT: ReadonlySet<Route> = new Set<Route>(["settings", "profile"]);

function destination(route: Route): Destination {
  const found = DESTINATIONS.find((d) => d.route === route);
  if (!found) throw new Error(`No destination for ${route}`);
  return found;
}

/**
 * The shape every rail button is drawn as: `IconButton`'s, at the rail's size.
 *
 * `enabled:` on the hover and the press for the reason `Button.tsx` gives: a
 * disabled control keeps its cursor and its title, and loses only its
 * response.
 */
export const railButton =
  "relative flex size-11 shrink-0 items-center justify-center rounded-control outline-none " +
  "transition-[background-color,color] duration-[var(--motion-fast)] ease-[var(--ease-state)] " +
  "focus-visible:ring-2 focus-visible:ring-accent " +
  "disabled:cursor-not-allowed disabled:text-text-disabled";

const resting =
  "text-text-mid enabled:hover:bg-fill-hover enabled:hover:text-text-hi enabled:active:bg-fill-active";

/** The accent tint `IconButton` uses for "on", deepening under the pointer rather than letting go. */
const current = "bg-accent/16 text-accent-soft enabled:hover:bg-accent/24";

function RailButton({
  icon,
  label,
  active,
  unread,
  onClick,
}: {
  route: Route;
  icon: IconName;
  label: string;
  active: boolean;
  unread: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={unread > 0 ? `${label}, ${unread} unread` : label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(railButton, active ? current : resting)}
    >
      <Icon name={icon} size={20} />
      {/* At the glyph's shoulder, ringed in the rail's own colour so it reads
          as sitting on the button rather than stuck over it. */}
      {unread > 0 ? (
        <span className="bg-accent ring-surface-0 absolute top-2 right-2 size-2.5 rounded-full ring-2" />
      ) : null}
    </button>
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
      className={cn(railButton, "text-text-mid enabled:hover:bg-danger/12 enabled:hover:text-danger")}
    >
      <Icon name="logout" size={20} />
    </button>
  );
}

/**
 * Your own profile, drawn as your face.
 *
 * A picture cannot take a tint the way a glyph does, so here "you are on it"
 * is a ring in the accent, set off from the picture by a gap in the rail's
 * colour so it reads as a selection around the avatar rather than a border on
 * it.
 */
function ProfileButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const account = useApp((s) => s.account);
  const avatarKey = useApp((s) => s.myAvatarKey);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "ring-offset-surface-0 relative flex size-11 shrink-0 items-center justify-center rounded-full outline-none",
        "transition-[box-shadow] duration-[var(--motion-fast)] ease-[var(--ease-state)]",
        "focus-visible:ring-accent focus-visible:ring-2 focus-visible:ring-offset-2",
        // The offset only with a ring: on its own it draws a solid 2px band
        // in the rail's colour, opaque over a rail that is not.
        active ? "ring-accent ring-2 ring-offset-2" : "hover:ring-line-strong hover:ring-2 hover:ring-offset-2",
      )}
    >
      {avatarKey ? (
        <RemoteImage imageKey={avatarKey} alt="" className="size-9 rounded-full" fit="cover" />
      ) : (
        <Avatar seed={account?.handle ?? "you"} name={account?.display_name ?? "You"} size={36} />
      )}
    </button>
  );
}
