import { afterEach, describe, expect, it, vi } from "vitest";
import { RELAY } from "../shared/relay";
import { handleRoom, type RoomView } from "./room";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const drawing = { w: 300, h: 200, strokes: [{ c: 0, s: 20, seed: 1, p: [10, 10, 290, 190] }] };

let ipN = 0;
async function call(body: Record<string, unknown>, env: Record<string, string> = {}) {
  const req = new Request("http://x/api/room", { method: "POST", headers: { "x-forwarded-for": `40.0.${ipN >> 8}.${ipN++ & 255}` }, body: JSON.stringify(body) });
  const res = await handleRoom(req, env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface Who {
  code: string;
  id: string;
  token: string;
}
const as = (p: Who, action: string, extra: Record<string, unknown> = {}, env?: Record<string, string>) =>
  call({ action, code: p.code, id: p.id, token: p.token, ...extra }, env);

async function room(n: number): Promise<Who[]> {
  const host = (await call({ action: "create", name: "방장" })).body as unknown as Who;
  const players = [host];
  for (let i = 1; i < n; i++) players.push((await call({ action: "join", code: host.code.toLowerCase(), name: `p${i}` })).body as unknown as Who);
  return players;
}

afterEach(() => vi.useRealTimers());

const seatOf = (v: RoomView, p: Who) => v.players.find((x) => x.id === p.id)!.seat;

describe("/api/room (memory store, no API key)", () => {
  it("plays a whole 3-player game: one story, write → draw → guess → reveal → wall", async () => {
    const ps = await room(3);
    const [host] = ps;
    expect(host.code).toMatch(/^[A-Z]{4}$/);

    let v = (await as(host, "state")).body as unknown as RoomView;
    expect(v.state.phase).toBe("lobby");
    expect(v.players.map((p) => p.name)).toEqual(["방장", "p1", "p2"]);
    expect((await as(ps[1], "start")).status).toBe(409); // only the host
    v = (await as(host, "start")).body as unknown as RoomView;
    expect(v.state).toMatchObject({ phase: "play", step: 0, n: 3 });
    // The first game's writer is the earliest joined: the host.
    expect(seatOf(v, host)).toBe(0);
    expect(v.task).toMatchObject({ kind: "write", step: 0, done: false });
    const bySeat = ps.slice().sort((a, b) => seatOf(v, a) - seatOf(v, b));

    // Only the player whose turn it is has a task, and only they can submit.
    expect(((await as(bySeat[1], "state")).body as unknown as RoomView).task).toBeUndefined();
    await as(bySeat[1], "submit", { step: 0, text: "가로채기" });
    expect((await as(bySeat[1], "chain")).status).toBe(409); // players see nothing before the reveal
    await as(bySeat[0], "submit", { step: 0, text: "고래가 춤을 춰요" });

    // Step 1: the next seat draws the sentence.
    v = (await as(bySeat[1], "state")).body as unknown as RoomView;
    expect(v.state.step).toBe(1);
    expect(v.task).toMatchObject({ kind: "draw", done: false });
    expect(v.task!.input!.text).toBe("고래가 춤을 춰요");
    expect(v.players.find((p) => p.id === bySeat[0].id)!.done).toBe(true);
    // The client already has the input: not sent again.
    const again = (await as(bySeat[1], "state", { have: v.task!.input!.key })).body as unknown as RoomView;
    expect(again.task!.input!.text).toBeUndefined();
    await as(bySeat[1], "submit", { step: 1, drawing });

    // Step 2: the last seat does not answer → filled in after the deadline.
    v = (await as(bySeat[2], "state")).body as unknown as RoomView;
    expect(v.task).toMatchObject({ kind: "guess", step: 2 });
    expect(v.task!.input!.drawing).toEqual(drawing);
    vi.useFakeTimers({ now: v.state.deadline + (RELAY.graceSeconds + 1) * 1000 });
    v = (await as(ps[0], "state")).body as unknown as RoomView;
    expect(v.state).toMatchObject({ phase: "reveal", rv: 0 });

    // Reveal: only the host moves it; the story shows all three entries.
    expect((await as(ps[1], "reveal", { rv: 1 })).status).toBe(409);
    await as(host, "reveal", { rv: 1 });
    type Got = { step: number; author: string; text?: string; drawing?: unknown; auto?: boolean; name: string };
    const story = (await as(ps[2], "chain")).body.entries as Got[];
    expect(story.map((e) => e.step)).toEqual([0, 1, 2]);
    expect(story[0]).toMatchObject({ text: "고래가 춤을 춰요", name: "방장" });
    expect(story[1].drawing).toEqual(drawing);
    expect(story[2]).toMatchObject({ author: "", auto: true, text: "???" });
    v = (await as(host, "reveal", { rv: 99 })).body as unknown as RoomView;
    expect(v.state).toMatchObject({ phase: "done", rv: 2 });

    // Carve the story into the wall (mock storage: the draft comes back for the client to keep).
    const pos = { x_mm: 1000, y_mm: 1000, w_mm: 300, h_mm: 200 };
    expect((await as(ps[1], "carve", { ...pos, image: PNG })).status).toBe(409);
    const carved = (await as(host, "carve", { ...pos, image: PNG })).body;
    expect(carved).toMatchObject({ ok: true, mode: "mock", draft: { relay: 3, src_w: 300, src_h: 200 } });
    expect((await as(host, "carve", { ...pos, image: PNG })).body).toMatchObject({ ok: false, reason: "done" });

    // 한 판 더: back to the lobby with the same players; the next joiner writes next.
    v = (await as(host, "again")).body as unknown as RoomView;
    expect(v.state).toMatchObject({ phase: "lobby", game: 1, carved: {} });
    expect(v.players).toHaveLength(3);
    v = (await as(host, "start")).body as unknown as RoomView;
    expect(seatOf(v, ps[1])).toBe(0);
  });

  it("skips a player who is away when their turn comes", async () => {
    const ps = await room(3);
    let v = (await as(ps[0], "start")).body as unknown as RoomView;
    const bySeat = ps.slice().sort((a, b) => seatOf(v, a) - seatOf(v, b));
    // Seat 1 leaves during the game; once seat 0 has written, their step is filled in shortly.
    await as(bySeat[1], "leave");
    await as(bySeat[0], "submit", { step: 0, text: "사슴" });
    vi.useFakeTimers({ now: Date.now() + RELAY.awaySkipMs + RELAY.leadSeconds * 1000 });
    v = (await as(bySeat[2], "state")).body as unknown as RoomView;
    expect(v.state.step).toBe(2);
    expect(v.task).toMatchObject({ kind: "guess" });
  });

  it("lets watchers in at any time, outside the game", async () => {
    const ps = await room(3);
    const early = (await call({ action: "join", code: ps[0].code, name: "구경", watch: true })).body as unknown as Who;
    let v = (await as(ps[0], "start")).body as unknown as RoomView;
    expect(v.state.n).toBe(3);
    expect(v.players.find((p) => p.id === early.id)).toMatchObject({ watch: true, seat: -1 });

    // A player cannot join a started room, a watcher can.
    expect((await call({ action: "join", code: ps[0].code, name: "늦음" })).body).toEqual({ error: "started" });
    const late = (await call({ action: "join", code: ps[0].code, name: "늦음", watch: true })).body as unknown as Who;
    v = (await as(late, "state")).body as unknown as RoomView;
    expect(v.task).toBeUndefined();

    // Watchers follow the story while it is played; their submits are ignored.
    const writer = ps.find((p) => seatOf(v, p) === 0)!;
    await as(late, "submit", { step: 0, text: "끼어들기" });
    expect((await as(late, "chain")).body.entries).toEqual([]);
    await as(writer, "submit", { step: 0, text: "배를 탄 사람들" });
    const seen = (await as(early, "chain")).body.entries as { text: string }[];
    expect(seen.map((e) => e.text)).toEqual(["배를 탄 사람들"]);
  });

  it("switches between playing and watching in the lobby", async () => {
    const ps = await room(3);
    expect((await as(ps[0], "role", { watch: true })).status).toBe(409); // not the host
    let v = (await as(ps[2], "role", { watch: true })).body as unknown as RoomView;
    expect(v.players.find((p) => p.id === ps[2].id)!.watch).toBe(true);
    expect((await as(ps[0], "start")).body).toEqual({ error: "few" });
    await as(ps[2], "role", { watch: false });
    v = (await as(ps[0], "start")).body as unknown as RoomView;
    expect(v.state.n).toBe(3);
  });

  it("deletes a room when the last one leaves, and sweeps empty rooms", async () => {
    const ps = await room(3);
    for (const p of ps) await as(p, "leave");
    expect((await call({ action: "join", code: ps[0].code, name: "x" })).status).toBe(404);

    const quiet = await room(3);
    vi.useFakeTimers({ now: Date.now() + RELAY.newRoomMs + RELAY.emptyMs + 3_600_000 });
    expect((await call({ action: "join", code: quiet[0].code, name: "x" })).status).toBe(404);
  });

  it("rejects bad words in a prompt, but fills in at the deadline", async () => {
    const ps = await room(3);
    await as(ps[0], "start");
    expect((await as(ps[0], "submit", { step: 0, text: "씨발 고래" })).body).toEqual({ error: "text" });
    const v = (await as(ps[0], "submit", { step: 0, text: "씨발 고래", final: true })).body as unknown as RoomView;
    expect(v.state.step).toBe(1); // filled in, and the story moved on
  });

  it("uses Qwen to check prompts when a key is set", async () => {
    const ps = await room(3);
    await as(ps[0], "start");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"flagged": true}' } }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect((await as(ps[0], "submit", { step: 0, text: "수상한 말" }, { DASHSCOPE_API_KEY: "sk-test" })).body).toEqual({ error: "text" });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses unknown rooms and bad tokens", async () => {
    const ps = await room(3);
    expect((await call({ action: "join", code: "ZZZZ", name: "x" })).status).toBe(404);
    expect((await as({ ...ps[1], token: "wrong" }, "state")).status).toBe(404);
  });

  it("needs three players and gives duplicate names a number", async () => {
    const ps = await room(2);
    expect((await as(ps[0], "start")).body).toEqual({ error: "few" });
    const third = (await call({ action: "join", code: ps[0].code, name: "p1" })).body as unknown as Who;
    const v = (await as(third, "state")).body as unknown as RoomView;
    expect(v.players.map((p) => p.name)).toEqual(["방장", "p1", "p12"]);
  });

  it("hands the host role on when the host leaves", async () => {
    const ps = await room(3);
    await as(ps[0], "leave");
    const v = (await as(ps[1], "state")).body as unknown as RoomView;
    expect(v.state.host).toBe(ps[1].id);
    expect(v.players).toHaveLength(2);
  });
});
