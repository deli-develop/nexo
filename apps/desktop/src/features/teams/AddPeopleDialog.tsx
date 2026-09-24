import { useEffect, useMemo, useState } from "react";

import { useApp } from "../../app/store";
import { useUserSearch } from "../../app/useUserSearch";
import { Button } from "../../components/ui/Button";
import { Field, Select, Tabs } from "../../components/ui/Controls";
import { HandleAvatar } from "../../components/ui/HandleAvatar";
import { Icon } from "../../components/ui/Icon";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/cn";
import { listBlocks } from "../../lib/blocks";
import { listConversations } from "../../lib/conversations";
import { addPeople, setRole, type AddOutcome, type RosterEntry, type Team } from "../../lib/teams";
import { addRow, TEAM_CAP } from "./roles";

type Segment = "search" | "group";
type PickRole = "member" | "admin";

interface Candidate {
  handle: string;
  name: string;
}

const HANDLE = /^[a-z0-9_]{3,20}$/;

/**
 * Adding people to a team.
 *
 * Two ways to find them: search, which finds public accounts and anybody
 * whose handle you type out in full; and "from a group", which brings the
 * people of a group conversation you are already in. Everybody who cannot be
 * added says why in their row -- already in, blocked by you, the team full,
 * or the server's single refusal for "private" and "blocked you" alike --
 * rather than quietly not appearing.
 *
 * The subtitle is the most important sentence in the dialog: somebody added
 * now reads what is posted from now on, not what came before. MLS gives a new
 * member nothing earlier, and there is no copy anywhere that could.
 */
export function AddPeopleDialog({
  team,
  roster,
  onClose,
  onAdded,
}: {
  team: Team;
  roster: RosterEntry[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const account = useApp((s) => s.account);
  const [segment, setSegment] = useState<Segment>("search");
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<Map<string, PickRole>>(new Map());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [outcomes, setOutcomes] = useState<Map<string, AddOutcome>>(new Map());
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<Array<{ id: string; title: string; members: string[] }>>([]);
  const [busy, setBusy] = useState(false);
  const search = useUserSearch(term);

  useEffect(() => {
    void listBlocks()
      .then((list) => setBlocked(new Set(list.map((b) => b.handle.toLowerCase()))))
      .catch(() => {});
    void listConversations()
      .then((all) =>
        setGroups(
          all
            .filter((c) => c.kind === "group")
            .map((c) => ({ id: c.conversation_id, title: c.title ?? "Group", members: c.members })),
        ),
      )
      .catch(() => {});
  }, []);

  const members = useMemo(() => new Set(roster.map((entry) => entry.handle.toLowerCase())), [roster]);
  const me = account?.handle.toLowerCase();
  const name = team.name ?? "this team";

  const candidates: Candidate[] = useMemo(() => {
    const found = search.results.map((r) => ({ handle: r.handle, name: r.display_name }));
    const typed = term.trim().toLowerCase().replace(/^@/, "");
    // A private account is not in search, and still addable by somebody it
    // has let in -- so a handle typed out in full is offered as it is.
    if (HANDLE.test(typed) && !found.some((c) => c.handle.toLowerCase() === typed)) {
      found.push({ handle: typed, name: `@${typed}` });
    }
    return found.filter((c) => c.handle.toLowerCase() !== me);
  }, [me, search.results, term]);

  function rowFor(handle: string) {
    const outcome = outcomes.get(handle);
    return addRow({
      handle,
      members,
      blocked,
      seatsTaken: roster.length + picked.size - (picked.has(handle) ? 1 : 0),
      ...(outcome ? { outcome } : {}),
    });
  }

  function pick(candidate: Candidate) {
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(candidate.handle)) next.delete(candidate.handle);
      else next.set(candidate.handle, "member");
      return next;
    });
    setNames((current) => new Map(current).set(candidate.handle, candidate.name));
  }

  function pickGroup(group: { members: string[] }) {
    const next = new Map(picked);
    for (const handle of group.members) {
      if (handle.toLowerCase() === me || next.has(handle)) continue;
      if (next.size + roster.length >= TEAM_CAP) break;
      if (rowFor(handle).state === "addable") next.set(handle, "member");
    }
    setPicked(next);
  }

  async function confirm() {
    if (busy || picked.size === 0) return;
    setBusy(true);
    try {
      const results = await addPeople(team.id, [...picked.keys()]);
      for (const result of results) {
        if (result.added && picked.get(result.handle) === "admin") {
          await setRole(team.id, result.handle, "admin").catch(() => {});
        }
      }
      setOutcomes(new Map(results.map((result) => [result.handle, result])));
      setPicked(new Map([...picked].filter(([handle]) => !results.find((r) => r.handle === handle)?.added)));
      onAdded();
      if (results.every((result) => result.added)) onClose();
    } finally {
      setBusy(false);
    }
  }

  const count = picked.size;

  return (
    <Modal label={`Add people to ${name}`} onClose={onClose}>
      <div className="rounded-panel bg-surface-2 flex max-h-full w-full max-w-[480px] flex-col border border-line">
        <div className="flex flex-col gap-3 p-5 pb-3">
          <span className="text-accent-soft flex size-10 items-center justify-center rounded-full bg-fill-hover ring-1 ring-line-strong">
            <Icon name="userPlus" size={19} />
          </span>
          <div>
            <h2 className="text-text-hi font-display text-[17px] font-medium">Add people to {name}</h2>
            <p className="text-text-mid mt-1 text-meta leading-relaxed">
              They'll see posts from now on, not earlier ones.
            </p>
          </div>
          <Tabs<Segment>
            tabs={[
              { id: "search", label: "Search" },
              { id: "group", label: "From a group" },
            ]}
            active={segment}
            onChange={setSegment}
          />
          {segment === "search" ? (
            <Field
              label="Search by name or handle"
              hideLabel
              icon="search"
              placeholder="Search by name or handle…"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              autoFocus
            />
          ) : null}
        </div>

        <div className="min-h-[120px] overflow-y-auto px-3 pb-2">
          {segment === "search" ? (
            candidates.length === 0 ? (
              <p className="text-text-lo px-2 py-6 text-center text-meta">
                {search.problem ?? (term.trim() ? "Nobody found. Type a handle out in full to add somebody private you're in touch with." : "Search for people to add.")}
              </p>
            ) : (
              <ul className="flex flex-col">
                {candidates.map((candidate) => (
                  <PersonRow
                    key={candidate.handle}
                    candidate={candidate}
                    row={rowFor(candidate.handle)}
                    role={picked.get(candidate.handle)}
                    onToggle={() => pick(candidate)}
                    onRole={(role) => setPicked(new Map(picked).set(candidate.handle, role))}
                  />
                ))}
              </ul>
            )
          ) : groups.length === 0 ? (
            <p className="text-text-lo px-2 py-6 text-center text-meta">You're not in any group conversations.</p>
          ) : (
            <ul className="flex flex-col">
              {groups.map((group) => {
                const others = group.members.filter((h) => h.toLowerCase() !== me);
                const addable = others.filter((h) => rowFor(h).state === "addable" && !picked.has(h));
                return (
                  <li key={group.id} className="flex items-center gap-3 rounded-control px-2 py-2">
                    <Icon name="messages" size={18} className="text-text-lo shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-text-hi truncate text-body font-medium">{group.title}</p>
                      <p className="text-text-lo truncate text-meta">{others.map((h) => `@${h}`).join(", ")}</p>
                    </div>
                    <Button variant="secondary" disabled={addable.length === 0} onClick={() => pickGroup(group)}>
                      {addable.length === 0 ? "Nobody to add" : `Pick ${addable.length}`}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {count > 0 && segment === "group" ? (
          <p className="text-text-mid px-5 text-meta">
            Picked: {[...picked.keys()].map((h) => names.get(h) ?? `@${h}`).join(", ")}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-[var(--hairline)] p-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || count === 0} onClick={() => void confirm()}>
            {busy ? "Adding…" : count === 1 ? "Add 1 person" : `Add ${count} people`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PersonRow({
  candidate,
  row,
  role,
  onToggle,
  onRole,
}: {
  candidate: Candidate;
  row: ReturnType<typeof addRow>;
  role: PickRole | undefined;
  onToggle: () => void;
  onRole: (role: PickRole) => void;
}) {
  const picked = role !== undefined;
  const available = row.state === "addable" || picked;
  return (
    <li className={cn("flex items-center gap-3 rounded-control px-2 py-2", picked && "bg-fill")}>
      <HandleAvatar handle={candidate.handle} name={candidate.name.replace(/^@/, "")} size={34} />
      <div className="min-w-0 flex-1">
        <p className="text-text-hi truncate text-body font-medium">{candidate.name}</p>
        <p className={cn("truncate text-meta", available ? "text-text-lo" : "text-text-mid")}>
          {row.state === "addable" || row.state === "added" ? `@${candidate.handle}` : row.reason}
        </p>
      </div>
      {row.state === "added" ? (
        <span className="text-success flex items-center gap-1 text-meta">
          <Icon name="check" size={14} />
          Added
        </span>
      ) : available ? (
        <>
          {picked ? (
            <Select<PickRole>
              label={`Role for @${candidate.handle}`}
              value={role}
              options={[
                { value: "member", label: "Member" },
                { value: "admin", label: "Admin" },
              ]}
              onChange={onRole}
            />
          ) : null}
          <Button variant={picked ? "ghost" : "secondary"} onClick={onToggle}>
            {picked ? "Remove" : "Add"}
          </Button>
        </>
      ) : null}
    </li>
  );
}
