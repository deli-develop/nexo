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
 * A column of discs. Every button is a raised circle standing on the rail, and
 * the one you are on is the same circle inverted -- the ink colour as the fill,
 * the surface as the glyph. That is the whole state system: no accent bar, no
 * tint, no badge. It used to be bare icons with a 3px accent marker on the
 * window edge, and the marker was the only thing that said where you were; a
 * filled disc says it from across the room, and it says it without spending
 * the accent, which stays reserved for "this one" in the content.
 *
 * Three groups, top to bottom. The mark, which is drawn in `TopBar`'s cell
 * above this column in the same disc so the two read as one rail. The run of
 * destinations you look at, centred in the column. And at the foot, the things
 * about *you*: Settings, sign-out, and your own face, which is how you get to
 * your profile.
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
export function IconRail({ unread }: { unread: number }) {
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
            unread={d.route === "messages" ? unread : 0}
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
 * The disc every rail button is drawn as.
 *
 * `enabled:` on the hover and the press for the reason `Button.tsx` gives: a
 * disabled control keeps its cursor and its title, and loses only its
 * response. The press moves the disc a pixel into the rail, the same gesture
 * as every bodied button in the library.
 */
const disc =
  "relative flex size-11 shrink-0 items-center justify-center rounded-full " +
  "shadow-[var(--shadow-chip)] " +
  "transition-[background-color,color,transform] duration-[var(--motion-fast)] ease-[var(--ease-state)] " +
  "enabled:active:translate-y-px disabled:cursor-not-allowed disabled:text-text-disabled";

const resting = "bg-surface-1 text-text-mid enabled:hover:bg-surface-2 enabled:hover:text-text-hi";

/** Inverted: the ink as the fill. Hover changes nothing -- you are already here. */
const current = "bg-text-hi text-surface-1";

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
      className={cn(disc, active ? current : resting)}
    >
      <Icon name={icon} size={19} />
      {/* On the disc's rim at one o'clock, ringed in the rail's own colour so
          it reads as sitting on the edge rather than stuck over it. */}
      {unread > 0 ? (
        <span className="bg-accent ring-surface-0 absolute top-0.5 right-0.5 size-2.5 rounded-full ring-2" />
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
 * Red only on hover, and only the glyph. A destructive action that is red at
 * rest is red for the hours nobody is going near it, and the colour stops
 * meaning anything; a red disc would be the loudest thing on the rail.
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
      className={cn(disc, "bg-surface-1 text-text-mid enabled:hover:bg-surface-2 enabled:hover:text-danger")}
    >
      <Icon name="logout" size={19} />
    </button>
  );
}

/**
 * Your own profile, drawn as your face.
 *
 * The picture fills the disc, so it cannot invert the way a glyph does. Here
 * is a ring instead, in the same ink colour the other discs fill with, and set
 * off from the picture by a gap in the rail's colour so it reads as a
 * selection around the avatar rather than a border on it.
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
        "ring-offset-surface-0 relative flex size-11 shrink-0 items-center justify-center rounded-full",
        "transition-[box-shadow,transform] duration-[var(--motion-fast)] ease-[var(--ease-state)] active:translate-y-px",
        // The offset only with a ring: on its own it draws a solid 2px band
        // in the rail's colour, opaque over a rail that is not.
        active
          ? "ring-text-hi ring-2 ring-offset-2"
          : "hover:ring-line-strong shadow-[var(--shadow-chip)] hover:ring-2 hover:ring-offset-2",
      )}
    >
      {avatarKey ? (
        <RemoteImage imageKey={avatarKey} alt="" className="size-11 rounded-full" fit="cover" />
      ) : (
        <Avatar seed={account?.handle ?? "you"} name={account?.display_name ?? "You"} size={44} />
      )}
    </button>
  );
}
