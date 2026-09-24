import { useEffect, useSyncExternalStore } from "react";

import { useApp } from "../../app/store";
import { Avatar } from "../../components/ui/Avatar";
import { HandleAvatar } from "../../components/ui/HandleAvatar";
import { knownProfile, loadProfile, subscribeProfiles } from "../../lib/profiles";
import type { Team } from "../../lib/teams";

/** Somebody's display name, once their public profile has been read. */
export function useDisplayName(handle: string | null): string | undefined {
  const profile = useSyncExternalStore(
    subscribeProfiles,
    () => (handle ? knownProfile(handle) : undefined),
    () => undefined,
  );
  useEffect(() => {
    if (handle) void loadProfile(handle).catch(() => {});
  }, [handle]);
  return profile?.display_name;
}

/**
 * Who wrote a post or a comment.
 *
 * MLS names the device a post came from, and the team's device list is what
 * turns that into a person. A device the list does not have belongs to
 * somebody who has since left, and says so rather than guessing a name.
 */
export function useAuthor(team: Team, device: string | null): { handle: string | null; name: string } {
  const account = useApp((s) => s.account);
  const handle = device === null ? account?.handle ?? null : team.devices[device] ?? null;
  const display = useDisplayName(handle);

  if (device === null) return { handle, name: account?.display_name ?? "You" };
  if (handle === null) return { handle: null, name: "Somebody who has left" };
  return { handle, name: display ?? `@${handle}` };
}

export function AuthorAvatar({ team, device, size }: { team: Team; device: string | null; size: number }) {
  const { handle, name } = useAuthor(team, device);
  return handle ? (
    // The bare handle for initials while the profile is loading: "@ada" would
    // draw an "@", which is nobody's initial.
    <HandleAvatar handle={handle} name={name.startsWith("@") ? handle : name} size={size} />
  ) : (
    <Avatar seed={device ?? "gone"} name={name} size={size} />
  );
}
