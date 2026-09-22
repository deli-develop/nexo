import { useCallback, useEffect, useMemo, useState } from "react";

import { useApp } from "./store";

import {
  asFeedError,
  myProfile as myProfileCall,
  postsBy,
  updateProfile as updateProfileCall,
  updateVisibility as updateVisibilityCall,
  uploadImageDataUrl,
  type MyProfile,
  type Post,
  type ProfileEdit,
  type Visibility,
  type VisibilityField,
} from "../lib/feed";

/**
 * Your own profile (§6.3) and its visibility settings (G2).
 *
 * `profile` is `null` until the first load finishes, so a caller renders
 * skeletons rather than a form full of empty strings that would look like a
 * profile someone had cleared.
 *
 * Every mutation returns the whole profile from the server and replaces the
 * local copy with it. No optimistic update here, unlike the feed's reactions:
 * these are deliberate edits behind a Save button, the round trip is expected,
 * and a visibility toggle that appeared to take effect but did not would be a
 * privacy control that lies.
 */
export interface LiveProfile {
  profile: MyProfile | null;
  posts: Post[];
  problem: string | null;
  loading: boolean;
  saving: boolean;
  save: (edit: ProfileEdit) => Promise<boolean>;
  setVisibility: (field: VisibilityField, value: Visibility) => Promise<void>;
  /** Commits a cropped image as the avatar or banner. */
  setImage: (which: "avatar" | "banner", dataUrl: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useProfile(): LiveProfile {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await myProfileCall();
      setProfile(me);
      // Published so anything drawing "you" can use the real picture. The post
      // composer is the one that needs it and is nowhere near this hook.
      useApp.getState().setMyAvatarKey(me.avatar_key);
      setProblem(null);
      // The posts tab, fetched here rather than in the tab: switching tabs
      // should not cost a round trip, and the count is wanted before anyone
      // opens it.
      try {
        const page = await postsBy(me.handle);
        setPosts(page.posts);
      } catch {
        // A profile that loaded with an empty posts list is still a usable
        // profile. The tab says so; the whole page does not fail for it.
      }
    } catch (error) {
      setProblem(asFeedError(error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (edit: ProfileEdit) => {
    setSaving(true);
    try {
      setProfile(await updateProfileCall(edit));
      setProblem(null);
      return true;
    } catch (error) {
      setProblem(asFeedError(error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const setVisibility = useCallback(
    async (field: VisibilityField, value: Visibility) => {
      try {
        setProfile(await updateVisibilityCall({ [field]: value }));
        setProblem(null);
      } catch (error) {
        // The switch snaps back, because `profile` is the only source of truth
        // for its position. That is the point: a privacy toggle must never sit
        // in a state the server does not agree with.
        setProblem(asFeedError(error).message);
      }
    },
    [],
  );

  const setImage = useCallback(
    async (which: "avatar" | "banner", dataUrl: string) => {
      setSaving(true);
      try {
        // Uploaded first, committed second (§5.3: objects are write-once). If
        // the upload fails the old picture stays, rather than the profile
        // pointing at an object that was never written.
        //
        // The bytes come from the cropper rather than from disk: what gets
        // stored is the region the person chose, already capped at 1920px.
        const key = await uploadImageDataUrl(dataUrl);
        const updated = await updateProfileCall(
          which === "avatar" ? { avatar_key: key } : { banner_key: key },
        );
        setProfile(updated);
        // Not via `refresh`: this path does not call it, and without this line
        // a new picture would show everywhere except the composer until the
        // next time the profile happened to be fetched.
        useApp.getState().setMyAvatarKey(updated.avatar_key);
        setProblem(null);
      } catch (error) {
        setProblem(asFeedError(error).message);
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  return useMemo(
    () => ({ profile, posts, problem, loading, saving, save, setVisibility, setImage, refresh }),
    [profile, posts, problem, loading, saving, save, setVisibility, setImage, refresh],
  );
}
