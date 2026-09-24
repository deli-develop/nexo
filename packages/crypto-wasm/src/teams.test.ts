/**
 * A team, with real MLS, three devices and an owner.
 *
 * `packages/core` drives the wasm module that ships; only the network is
 * faked, and the fake server below does what `apps/server` does for a team --
 * routing, roles, ordering -- and never looks inside a ciphertext. What this
 * proves is the part the server cannot: who can **read** what.
 *
 *  - Members added before a post read it.
 *  - A member removed, and the group rekeyed, cannot read what comes after --
 *    not by syncing (the server refuses) and not with the ciphertext in hand.
 *  - A member added later reads nothing from before, and the board says so
 *    rather than drawing an empty past.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";

import * as conversations from "../../core/src/conversations";
import { Store } from "../../core/src/store";
import * as teams from "../../core/src/teams";
import { Transport } from "../../core/src/transport";
import { bindWasm, type WasmModule } from "../../core/src/wasm";
import type { BoardPost } from "../../core/src/board";
import type { ConversationSummary, Envelope } from "../../core/src/types";

import * as wasm from "../pkg/nexo_crypto_wasm.js";

interface Caller {
  handle: string;
  device: string;
}

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/** A delivery service with teams in it, and nothing that reads content. */
class TeamServer {
  envelopes: Envelope[] = [];
  /** conversation -> handle -> role */
  teams = new Map<string, Map<string, string>>();
  devices = new Map<string, string>();
  keyPackages = new Map<string, string[]>();
  #next = 1;

  handle(caller: Caller, method: string, path: string, body: Record<string, unknown>): unknown {
    this.devices.set(caller.handle, caller.device);
    const route = path.split("?")[0]!;

    if (route === "/v1/keypackages" && method === "POST") {
      this.keyPackages.set(caller.handle, [...(body["key_packages"] as string[])]);
      return {};
    }
    if (route.startsWith("/v1/keypackages/") && method === "GET") {
      const handle = decodeURIComponent(route.slice("/v1/keypackages/".length));
      const one = this.keyPackages.get(handle)?.shift();
      if (!one) throw new Refusal(404, "not_found");
      return { device_id: this.devices.get(handle), key_package: one };
    }
    if (route === "/v1/teams" && method === "POST") {
      const id = body["conversation_id"] as string;
      this.teams.set(id, new Map([[caller.handle, "owner"]]));
      return { conversation_id: id, role: "owner", member_count: 1, created_at_ms: 0 };
    }
    if (route === "/v1/conversations" && method === "GET") {
      return [...this.teams.entries()]
        .filter(([, roster]) => roster.has(caller.handle))
        .map(([id, roster]): ConversationSummary => ({
          conversation_id: id,
          kind: "team",
          epoch: 0,
          latest_envelope_id: this.latest(id),
          members: [...roster.keys()],
          member_devices: [...roster.keys()].map((handle) => ({
            handle,
            device_id: this.devices.get(handle)!,
          })),
        }));
    }

    const match = /^\/v1\/(conversations|teams)\/([^/]+)(\/.*)?$/.exec(route);
    if (!match) throw new Error(`the fake server has no ${method} ${path}`);
    const [, , id, rest = ""] = match;
    const roster = this.teams.get(id!);
    const role = roster?.get(caller.handle);
    if (!roster || !role) throw new Refusal(404, "not_found");
    const moderates = role === "owner" || role === "admin";

    if (rest === "/members" && method === "POST") {
      if (!moderates) throw new Refusal(403, "not_permitted");
      roster.set(body["handle"] as string, "member");
      return undefined;
    }
    if (rest === "/members/remove" && method === "POST") {
      if (!moderates) throw new Refusal(403, "not_permitted");
      roster.delete(body["handle"] as string);
      return undefined;
    }
    if (rest === "/members" && method === "GET") {
      return [...roster.entries()].map(([handle, r]) => ({ handle, role: r, joined_at_ms: 0 }));
    }
    if (rest === "/send") {
      const envelope: Envelope = {
        envelope_id: this.#next++,
        conversation_id: id!,
        sender_device_id: caller.device,
        epoch: body["epoch"] as number,
        ciphertext: body["ciphertext"] as string,
        server_timestamp_ms: 1_700_000_000_000 + this.#next,
        is_commit: body["is_commit"] as boolean,
      };
      this.envelopes.push(envelope);
      return { envelope_id: envelope.envelope_id, epoch: envelope.epoch };
    }
    if (rest === "/sync") {
      const since = Number(new URLSearchParams(path.split("?")[1]).get("since_id") ?? 0);
      return this.envelopes.filter((e) => e.conversation_id === id && e.envelope_id > since);
    }
    throw new Error(`the fake server has no ${method} ${path}`);
  }

  latest(id: string): number | null {
    const mine = this.envelopes.filter((e) => e.conversation_id === id);
    return mine.length === 0 ? null : mine[mine.length - 1]!.envelope_id;
  }
}

async function client(server: TeamServer, handle: string, device: string) {
  const transport = new Transport({
    baseUrl: "https://api.test",
    fetch: (async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      try {
        const answer = server.handle({ handle, device }, init.method ?? "GET", parsed.pathname + parsed.search, body);
        return answer === undefined
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        return new Response(JSON.stringify({ error: error.code, message: error.code }), {
          status: error.status,
          headers: { "content-type": "application/json" },
        });
      }
    }) as unknown as typeof globalThis.fetch,
  });
  transport.adopt({ access_token: "a", refresh_token: "r" });

  const store = await Store.open(`teams-${handle}`, new IDBFactory());
  await store.setIdentity({ deviceId: device, secret: Uint8Array.of(0) });
  await store.setAccount({ userId: 1, handle, displayName: handle });
  const crypto = bindWasm(wasm as unknown as WasmModule);
  const ctx: conversations.Context = {
    transport,
    store,
    crypto,
    device: crypto.newDevice(device),
    now: () => 1_700_000_000_000,
  };
  await conversations.publishKeyPackages(ctx, 4);
  return { ctx, store };
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADA = "22222222-2222-4222-8222-222222222222";
const BO = "33333333-3333-4333-8333-333333333333";
const CY = "44444444-4444-4444-8444-444444444444";

const bodies = (board: Awaited<ReturnType<typeof teams.board>>) =>
  board.items.filter((item): item is BoardPost => item.kind === "post").map((post) => post.body);

describe("a team over the real MLS module", () => {
  beforeAll(() => {
    wasm.initPanicHook();
  });

  it("lets members read what was posted while they were in, and nothing else", async () => {
    const server = new TeamServer();
    const owner = await client(server, "owner", OWNER);
    const ada = await client(server, "ada", ADA);
    const bo = await client(server, "bo", BO);

    const id = await teams.createTeam(owner.ctx, "Design crew");
    const added = await teams.addPeople(owner.ctx, id, ["ada", "bo"]);
    expect(added.every((outcome) => outcome.added)).toBe(true);
    await teams.post(owner.ctx, id, { title: "Monday", body: "first post" });

    // Both read it, and both know what the team is called -- the name was
    // sent after they joined, because nothing before could be read by them.
    for (const member of [ada, bo]) {
      await conversations.syncAll(member.ctx);
      expect(bodies(await teams.board(member.ctx, id))).toEqual(["first post"]);
      expect((await member.store.conversation(id))?.title).toBe("Design crew");
      expect((await teams.board(member.ctx, id)).joinedLate).toBe(true);
    }

    // Bo is removed, and the group rekeys.
    await teams.removePerson(owner.ctx, id, "bo");
    await teams.post(owner.ctx, id, { body: "second post" });
    const second = server.envelopes[server.envelopes.length - 1]!;

    // The server no longer hands Bo anything...
    await expect(conversations.sync(bo.ctx, id)).rejects.toMatchObject({ kind: "not_found" });
    // ...and with the ciphertext in hand anyway, Bo's keys do not open it.
    const boGroup = bo.ctx.crypto.loadGroup(bo.ctx.device, id, 0)!;
    expect(() => boGroup.decrypt(bo.ctx.device, conversations.fromHex(second.ciphertext))).toThrow();
    expect(bodies(await teams.board(bo.ctx, id))).toEqual(["first post"]);

    // Ada, still in, reads both.
    await conversations.syncAll(ada.ctx);
    expect(bodies(await teams.board(ada.ctx, id))).toEqual(["second post", "first post"]);

    // Cy arrives after all of that.
    const cy = await client(server, "cy", CY);
    expect((await teams.addPeople(owner.ctx, id, ["cy"]))[0]!.added).toBe(true);
    await conversations.syncAll(cy.ctx);

    const board = await teams.board(cy.ctx, id);
    // Neither earlier post, and the board says why instead of looking empty.
    expect(bodies(board)).toEqual([]);
    expect(board.joinedLate).toBe(true);
    expect((await cy.store.conversation(id))?.title).toBe("Design crew");
    // Not for want of trying: the first post's ciphertext does not open for Cy.
    const first = server.envelopes.find((e) => e.conversation_id === id && e.envelope_id < second.envelope_id
      && !e.is_commit && e.sender_device_id === OWNER)!;
    const cyGroup = cy.ctx.crypto.loadGroup(cy.ctx.device, id, 0)!;
    expect(() => cyGroup.decrypt(cy.ctx.device, conversations.fromHex(first.ciphertext))).toThrow();

    // And whatever comes next, Cy reads.
    await teams.post(owner.ctx, id, { body: "welcome, cy" });
    await conversations.syncAll(cy.ctx);
    expect(bodies(await teams.board(cy.ctx, id))).toEqual(["welcome, cy"]);

    // The owner's own board has all three.
    expect(bodies(await teams.board(owner.ctx, id))).toEqual(["welcome, cy", "second post", "first post"]);
  });

  it("does not let a member add somebody, and sends no commit when refused", async () => {
    const server = new TeamServer();
    const owner = await client(server, "owner", OWNER);
    const ada = await client(server, "ada", ADA);
    await client(server, "bo", BO);

    const id = await teams.createTeam(owner.ctx, "Crew");
    await teams.addPeople(owner.ctx, id, ["ada"]);
    await conversations.syncAll(ada.ctx);
    const before = server.envelopes.length;

    const [outcome] = await teams.addPeople(ada.ctx, id, ["bo"]);
    expect(outcome!.added).toBe(false);
    // Refused at the routing step, before any commit went out.
    expect(server.envelopes.length).toBe(before);
    expect(server.teams.get(id)!.has("bo")).toBe(false);
  });
});
