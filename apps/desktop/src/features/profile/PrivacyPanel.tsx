import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Feedback";
import { confirm, copyText, notify } from "../../lib/native";
import { asFeedError, updateProfile } from "../../lib/feed";
import {
  createInvite,
  listInvites,
  revokeInvite,
  type Invite,
  type MintedInvite,
} from "../../lib/people";

/**
 * Public or private, and the invitations that get past private.
 *
 * The two belong together because they are one decision seen from two sides:
 * whether strangers can find you, and how a particular stranger gets through
 * anyway.
 *
 * **What "private" honestly covers**, and the UI says exactly this much:
 *
 *  - You do not appear in search.
 *  - Somebody who does not already share a conversation with you cannot open
 *    one without a live invitation.
 *
 * Both are enforced on the server, which is the only reason the word is
 * offered at all — `profiles.rs` refused a visibility switch for handle and
 * display name precisely because it could not be kept.
 *
 * **What it does not cover**, and the panel says so rather than letting it be
 * assumed: people already in touch stay in touch, anything already sent has
 * been sent, and a handle typed exactly still reaches a public account.
 */
export function PrivacyPanel({
  isPrivate,
  onChanged,
}: {
  isPrivate: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [minted, setMinted] = useState<MintedInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInvites(await listInvites());
    } catch (error) {
      setProblem(asFeedError(error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setPrivate(next: boolean) {
    setBusy(true);
    try {
      await updateProfile({ is_private: next });
      await onChanged();
    } catch (error) {
      setProblem(asFeedError(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function mint() {
    setBusy(true);
    try {
      // Seven days is both the default and the ceiling; the server enforces it
      // and so does the table.
      setMinted(await createInvite(undefined, 7));
      await load();
    } catch (error) {
      setProblem(asFeedError(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(invite: Invite) {
    const ok = await confirm(
      "Withdraw this invitation",
      "Anyone still holding it will no longer be able to reach you with it. People who already have will stay in touch.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      await revokeInvite(invite.id);
      await load();
    } catch (error) {
      setProblem(asFeedError(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h2 className="text-text-hi font-display text-[17px] font-medium">
          Who can find you
        </h2>
        <p className="text-text-lo mt-1 text-meta">
          {isPrivate
            ? "You are private: you do not appear in search, and somebody new needs an invitation to write to you."
            : "You are public: anyone signed in can find you by name and write to you."}
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          variant={isPrivate ? "secondary" : "primary"}
          onClick={() => void setPrivate(false)}
          disabled={busy || !isPrivate}
        >
          Public
        </Button>
        <Button
          variant={isPrivate ? "primary" : "secondary"}
          onClick={() => void setPrivate(true)}
          disabled={busy || isPrivate}
        >
          Private
        </Button>
      </div>

      {isPrivate ? (
        <Callout tone="neutral" icon="info">
          Going private does not undo anything. People you already share a
          conversation with can still write to you, and anything already sent
          has been sent.
        </Callout>
      ) : null}

      {problem ? (
        <Callout tone="warning" icon="alert">
          {problem}
        </Callout>
      ) : null}

      <div>
        <h3 className="text-text-hi text-[14px] font-medium">Invitations</h3>
        <p className="text-text-lo mt-1 text-meta">
          An invitation lets one person reach you while you are private. It
          lasts at most seven days.
        </p>
        <Button className="mt-2" onClick={() => void mint()} disabled={busy}>
          Create an invitation
        </Button>
      </div>

      {minted ? (
        <Callout tone="warning" icon="alert" title="Copy this now">
          {/* Said plainly because it is true and cannot be undone: the server
              keeps a hash, so there is nothing to look up later. */}
          <p className="mb-2">
            This is the only time this invitation can be read. If you lose it,
            withdraw it and make another.
          </p>
          <code className="text-text-hi block break-all font-mono text-[12px]">
            {minted.secret}
          </code>
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() => {
                void copyText(minted.secret);
                void notify("Copied", "The invitation is on your clipboard.");
              }}
            >
              Copy
            </Button>
            <Button onClick={() => setMinted(null)}>Done</Button>
          </div>
        </Callout>
      ) : null}

      {invites && invites.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {invites.map((invite) => (
            <li
              key={invite.id}
              className="rounded-panel bg-surface-2 border-line flex items-center gap-3 border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-text-hi truncate text-[13px]">
                  {invite.label ?? "Invitation"}
                </p>
                <p className="text-text-lo text-meta">
                  {invite.revoked
                    ? "Withdrawn"
                    : invite.live
                      ? `Expires ${new Date(invite.expires_at_ms).toLocaleDateString()}`
                      : "Expired"}
                  {invite.used > 0
                    ? ` · used by ${invite.used} ${invite.used === 1 ? "person" : "people"}`
                    : null}
                </p>
              </div>
              {invite.live ? (
                <Button onClick={() => void withdraw(invite)} disabled={busy}>
                  Withdraw
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
