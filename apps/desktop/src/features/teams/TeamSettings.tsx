import { useEffect, useState } from "react";

import { useApp } from "../../app/store";
import { Button } from "../../components/ui/Button";
import { Field, Select, TextArea } from "../../components/ui/Controls";
import { Callout } from "../../components/ui/Feedback";
import { asConversationError, setConversationAvatar } from "../../lib/conversations";
import { confirm, pickFile } from "../../lib/native";
import {
  deleteTeam,
  describeTeam,
  leaveTeam,
  renameTeam,
  teamRoster,
  transferTeam,
  type RosterEntry,
  type Team,
} from "../../lib/teams";

/**
 * A team's name, what it is for, its picture -- and the ways out of it.
 *
 * The name, description and picture are messages like any other: sent inside
 * the ciphertext, so the server never learns them, and honoured by every
 * member's device only from the owner or an admin. Leaving and deleting are
 * the server's, and say what they can and cannot reach.
 */
export function TeamSettings({
  team,
  onChanged,
  onGone,
}: {
  team: Team;
  /**
   * Something here changed the team: read the list again. It used to wait for
   * the next sync pass to notice, and the board beside a "Saved." went on
   * showing the old name.
   */
  onChanged: () => void;
  onGone: () => void;
}) {
  const account = useApp((s) => s.account);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [name, setName] = useState(team.name ?? "");
  const [description, setDescription] = useState(team.description ?? "");
  const [heir, setHeir] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const moderates = team.myRole === "owner" || team.myRole === "admin";
  const owner = team.myRole === "owner";
  const me = account?.handle.toLowerCase();

  useEffect(() => {
    void teamRoster(team.id)
      .then(setRoster)
      .catch(() => {});
  }, [team.id]);

  async function run(label: string, action: () => Promise<void>, done?: string) {
    setBusy(label);
    setProblem(null);
    setSaved(null);
    try {
      await action();
      onChanged();
      if (done) setSaved(done);
    } catch (error) {
      setProblem(asConversationError(error).message);
    } finally {
      setBusy(null);
    }
  }

  const heirs = roster.filter((entry) => entry.handle.toLowerCase() !== me);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-4 py-5 sm:px-6">
        <h2 className="font-display text-text-hi text-[20px] font-semibold tracking-[-0.01em]">Team settings</h2>
        {problem ? <Callout tone="danger">{problem}</Callout> : null}
        {saved ? <Callout>{saved}</Callout> : null}

        {moderates ? (
          <section className="flex flex-col gap-3">
            <Field label="Name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            <TextArea
              label="What it's for"
              value={description}
              rows={3}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy !== null || name.trim() === ""}
                onClick={() =>
                  void run(
                    "save",
                    async () => {
                      if (name.trim() !== (team.name ?? "")) await renameTeam(team.id, name);
                      if (description.trim() !== (team.description ?? "")) await describeTeam(team.id, description);
                    },
                    "Saved. Every member sees the change.",
                  )
                }
              >
                Save
              </Button>
              <Button
                icon="image"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "picture",
                    async () => {
                      const picked = await pickFile({ images: true, title: "Choose a picture" });
                      if (picked) await setConversationAvatar(team.id, picked);
                    },
                    "Picture changed.",
                  )
                }
              >
                Change picture
              </Button>
            </div>
            <p className="text-text-lo text-meta leading-relaxed">
              The name, description and picture are sent inside the team's encryption. The server never learns them.
            </p>
          </section>
        ) : (
          <p className="text-text-mid text-body">Only the owner and admins can change the team's name, description and picture.</p>
        )}

        {owner ? (
          <section className="flex flex-col gap-3 border-t border-[var(--hairline)] pt-5">
            <h3 className="text-text-hi text-body font-semibold">Hand the team on</h3>
            <p className="text-text-mid text-meta leading-relaxed">
              The new owner can do everything you can now, including delete the team. You stay, as an admin.
            </p>
            {heirs.length === 0 ? (
              <p className="text-text-lo text-meta">There is nobody else in the team to hand it to.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Select<string>
                  label="New owner"
                  value={heir || heirs[0]!.handle}
                  options={heirs.map((entry) => ({ value: entry.handle, label: `@${entry.handle}` }))}
                  onChange={setHeir}
                />
                <Button
                  disabled={busy !== null}
                  onClick={() =>
                    void run("transfer", async () => {
                      const to = heir || heirs[0]!.handle;
                      const ok = await confirm(
                        `Make @${to} the owner`,
                        `@${to} becomes the owner of ${team.name ?? "this team"}. You become an admin, and only they can hand it back.`,
                      );
                      if (ok) await transferTeam(team.id, to);
                    }, "Handed on.")
                  }
                >
                  Hand on
                </Button>
              </div>
            )}
          </section>
        ) : null}

        <section className="flex flex-col gap-3 border-t border-[var(--hairline)] pt-5">
          {owner ? (
            <>
              <h3 className="text-text-hi text-body font-semibold">Delete the team</h3>
              <p className="text-text-mid text-meta leading-relaxed">
                It goes from every member's list and nobody can post to it again. The server deletes what it holds;
                what members already have on their devices is theirs.
              </p>
              <div>
                <Button
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() =>
                    void run("delete", async () => {
                      const ok = await confirm(
                        `Delete ${team.name ?? "this team"}`,
                        "It goes for everybody in it, and cannot be undone. Copies already on members' devices stay there.",
                      );
                      if (!ok) return;
                      await deleteTeam(team.id);
                      onGone();
                    })
                  }
                >
                  Delete team
                </Button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-text-hi text-body font-semibold">Leave the team</h3>
              <p className="text-text-mid text-meta leading-relaxed">
                You stop receiving it, and it goes from this device. Somebody has to add you again to come back, and you
                won't see what was posted while you were away.
              </p>
              <div>
                <Button
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() =>
                    void run("leave", async () => {
                      const ok = await confirm(`Leave ${team.name ?? "this team"}`, "You stop receiving it, and it goes from this device.");
                      if (!ok) return;
                      await leaveTeam(team.id);
                      onGone();
                    })
                  }
                >
                  Leave team
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
