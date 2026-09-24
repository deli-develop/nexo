import { TEAM_POST_MAX_FILES } from "@nexo/core";
import { useState } from "react";

import { Button, IconButton } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { fileSize } from "../../lib/format";
import { pickFile, type PickedFile } from "../../lib/native";
import { postToTeam, sealTeamFile, type Team } from "../../lib/teams";

/**
 * Writing a post, with who will read it said where you write.
 *
 * The feed's composer says "Posts are public" in this position; this one says
 * the opposite, and says it as a count of real people rather than an
 * adjective. Both lines are the product's central claim made at the one place
 * it matters -- before somebody decides what to write.
 */
export function TeamComposer({ team, onPosted }: { team: Team; onPosted: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const members = team.members.length;
  const who = members === 1 ? "only you" : `the ${members} members of ${team.name ?? "this team"}`;

  async function attach() {
    const picked = await pickFile({ title: "Attach a file" });
    if (picked) setFiles((current) => [...current, picked].slice(0, TEAM_POST_MAX_FILES));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || (body.trim() === "" && files.length === 0)) return;
    setBusy(true);
    setProblem(null);
    try {
      // Uploaded first, sealed each with its own key, and only then named in
      // the post: a post naming an object that never arrived is a broken
      // file for everybody, and MLS will not let it be sent again.
      const sealed = [];
      for (const file of files) sealed.push(await sealTeamFile(team.id, file));
      await postToTeam(team.id, { title, body, files: sealed });
      setTitle("");
      setBody("");
      for (const file of files) URL.revokeObjectURL(file.url);
      setFiles([]);
      onPosted();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That was not posted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-panel flex flex-col gap-2 border border-line bg-surface-2/60 p-3">
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label="Title (optional)"
        placeholder="Title (optional)"
        className="text-text-hi placeholder:text-text-lo rounded-control bg-transparent px-2 py-1 text-title font-semibold outline-none focus-visible:bg-fill"
      />
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-label="Post"
        placeholder={`Write to ${team.name ?? "the team"}`}
        rows={3}
        className="text-text-hi placeholder:text-text-lo rounded-control min-h-20 resize-y bg-transparent px-2 py-1 text-message leading-relaxed outline-none focus-visible:bg-fill"
      />

      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 px-1">
          {files.map((file, index) => (
            <li key={file.url} className="rounded-control text-text-mid flex items-center gap-1.5 bg-fill py-1 pr-1 pl-2 text-meta">
              <Icon name={file.mime.startsWith("image/") ? "image" : "file"} size={13} />
              <span className="max-w-[16ch] truncate">{file.name}</span>
              <span className="text-text-lo">{fileSize(file.bytes.byteLength)}</span>
              <IconButton
                name="close"
                label={`Remove ${file.name}`}
                size={12}
                className="size-6"
                onClick={() => {
                  URL.revokeObjectURL(file.url);
                  setFiles((current) => current.filter((_, i) => i !== index));
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-2 border-t border-[var(--hairline)] pt-2">
        <IconButton
          name="paperclip"
          label="Attach a file"
          size={17}
          disabled={files.length >= TEAM_POST_MAX_FILES}
          onClick={() => void attach()}
        />
        <p className="text-text-mid flex min-w-0 flex-1 items-center gap-1.5 text-meta">
          <Icon name="team" size={14} className="text-text-lo shrink-0" />
          <span className="truncate">
            Visible to {who}. End-to-end encrypted.
          </span>
        </p>
        <Button type="submit" variant="primary" disabled={busy || (body.trim() === "" && files.length === 0)}>
          {busy ? "Posting…" : "Post"}
        </Button>
      </div>
      {problem ? <p className="text-danger px-1 text-meta">{problem}</p> : null}
    </form>
  );
}
