import { asConversationError } from "../../lib/conversations";
import { postStory } from "../../lib/stories";
import { pickFile } from "../../lib/native";

/** What happened, so a caller can react without a second error convention. */
export type StoryPost =
  | { posted: true }
  | { posted: false; problem?: string };

/**
 * Picks a file and posts it as a story.
 *
 * Extracted because there are two places to start a story from — the strip on
 * Home and the plus on your own profile picture — and they must not be two
 * flows. The picker's filter is the part that would drift: `media`, not
 * `images`, because a story can be a video and the sniffer has understood MP4
 * and WebM all along. A second call site that forgot that would refuse videos
 * for no reason anyone could see.
 *
 * Cancelling the picker is `posted: false` with no problem. Nothing went
 * wrong; the person changed their mind, and telling them about it would be an
 * error message for a decision.
 */
export async function pickAndPostStory(): Promise<StoryPost> {
  const picked = await pickFile({ title: "Post a story", media: true });
  if (!picked) return { posted: false };
  try {
    await postStory(picked);
    return { posted: true };
  } catch (error) {
    return { posted: false, problem: asConversationError(error).message };
  }
}
