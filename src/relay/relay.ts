// 이어 그리기 screens: join → lobby → (write → draw → guess …) → reveal → done.
// The server decides which step the room is at (src/relay/api.ts polls it); this controller
// turns each room view into a screen. The rock itself (drawing, carving, camera, the shared
// wall) belongs to main.ts and is reached through RelayHost.

import { chainStrip, RELAY, revealAt, type RelayDrawing, type StepKind } from "../../shared/relay";
import type { CarvingDraft, Rect } from "../../shared/wall";
import { dialog, toast } from "../ui/notice";
import { RelayApi, RoomError, saveName, savedName, type ChainEntry, type RoomView } from "./api";

export interface RelayHost {
  /** Shows the relay screens over an empty rock; free drawing and the challenge are off. */
  enter(): void;
  /** Back to free drawing at a new spot. */
  exit(): Promise<void>;
  /** Clears the rock and moves to a new free spot. */
  freshRock(): Promise<void>;
  /** Shows the drawing tools; the brush works only when `enabled`. */
  startDrawing(enabled: boolean): void;
  /** Stops drawing; the drawing in its own frame (empty: w = h = 0). The strokes stay shown. */
  stopDrawing(): RelayDrawing;
  /** Carves someone's drawing at the current spot and frames it (pecked mark by mark if `timelapse`). */
  showDrawing(d: RelayDrawing | null, timelapse: boolean): Promise<void>;
  /** A free spot on the shared wall for a chain strip; null if the wall is full. */
  stripSpot(strip: RelayDrawing): Promise<Rect | null>;
  /** The strip as a flat silhouette PNG (for moderation). */
  stripPNG(strip: RelayDrawing): string | null;
  /** Keeps a carving on this device's wall (no shared storage). */
  keepLocal(d: CarvingDraft): void;
  showWall(focus?: Rect): Promise<void>;
  inWall(): boolean;
  /** Geolocation gate of the shared wall (shows its own message when not near). */
  nearSite(): Promise<boolean>;
}

type Screen = "join" | "lobby" | StepKind | "wait" | "reveal" | "done";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const el = (tag: string, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const EXAMPLES = [
  "작살 든 사람이 고래를 쫓아요", "새끼 고래가 엄마 등에 업혔어요", "호랑이가 사슴을 몰래 지켜봐요",
  "배를 탄 사람들이 노를 저어요", "춤추는 거북", "물새가 고래 위를 날아요", "멧돼지가 낮잠을 자요",
];
const TIMER_LABEL: Record<StepKind, string> = { write: "이야기", draw: "새기기", guess: "맞히기" };
const JOIN_ERRORS: Record<string, string> = {
  nope: "그런 방이 없어요. 코드를 확인해 주세요.",
  started: "이미 시작한 방이에요.",
  full: "방이 꽉 찼어요 (최대 8명).",
  limited: "잠시 후에 다시 시도해 주세요.",
  noserver: "이 주소에서는 방을 만들 수 없어요 (서버 없음).",
};

export class Relay {
  /** The relay screens are showing. */
  active = false;
  /** The draw step is on (the 다 그렸어요 button finishes it). */
  drawing = false;
  /** Called when the relay screens open or close (mode switch state). */
  onActive: () => void = () => {};

  private api = new RelayApi();
  private v: RoomView | null = null;
  private screen: Screen | null = null;
  /** The step the screen was set up for. */
  private stepKey = "";
  /** Step whose answer is being sent (no second send meanwhile). */
  private sending = "";
  private inputs = new Map<string, { text?: string | null; drawing?: RelayDrawing | null; from: string }>();
  private chains = new Map<string, ChainEntry[]>();
  private shownRv = "";
  private queued = false;
  private running: Promise<void> = Promise.resolve();
  private timerRaf = 0;
  private qrFor = "";
  private picked = { chain: -1, item: -1 };
  private carving = false;

  constructor(private host: RelayHost) {
    this.api.onView = (v) => this.render(v);
    this.api.onLost = () => {
      if (!this.active) return;
      dialog("방이 닫혔어요", "이 방은 더 이상 없어요.", [{ label: "확인", value: 0, primary: true }]).then(() => this.close());
    };
    this.api.onTrouble = (bad) => bad && toast("연결이 불안정해요. 계속 다시 시도하는 중…", 3000);
    this.wire();
  }

  // ---------------------------------------------------------------- open / close

  /** Opens the relay screens: resumes a saved game, else the join screen (`code` prefilled). */
  async open(code = "") {
    this.active = true;
    this.host.enter();
    this.onActive();
    $<HTMLInputElement>("rlName").value = savedName();
    $<HTMLInputElement>("rlCode").value = code;
    const s = this.api.session;
    if (s && (!code || code === s.code)) {
      this.show("wait");
      try {
        await this.api.state();
        this.api.start();
        return;
      } catch (err) {
        if (!(err instanceof RoomError && err.code === "nope")) {
          this.api.start(); // network trouble: keep trying
          return;
        }
        await this.api.leave();
      }
    }
    this.screen = "join";
    this.show("join");
  }

  /** Startup: a ?room= link or a game in progress reopens the relay screens. */
  boot() {
    const code = new URLSearchParams(location.search).get("room")?.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) ?? "";
    if (code || this.api.session) void this.open(code);
  }

  private async close() {
    this.api.stop();
    this.active = false;
    this.drawing = false;
    this.v = null;
    this.screen = null;
    this.stepKey = this.sending = this.shownRv = "";
    this.stopTimer();
    this.card(null);
    this.prompt(null);
    $("rlQr").classList.remove("show");
    delete document.body.dataset.rl;
    this.onActive();
    await this.host.exit();
  }

  /** 나가기 (with a confirmation while playing). */
  async quit() {
    const playing = this.v && this.v.state.phase === "play";
    if (playing) {
      const go = await dialog("게임에서 나갈까요?", "내 차례는 자동으로 채워져요.\n같은 방에 다시 들어올 수는 없어요.", [
        { label: "계속하기", value: false },
        { label: "나가기", value: true, primary: true },
      ]);
      if (!go) return;
    }
    await this.api.leave();
    await this.close();
  }

  /** Back from the shared wall. */
  resume() {
    if (this.active) this.sync();
  }

  // ---------------------------------------------------------------- views

  private render(v: RoomView) {
    if (!this.active) return;
    const prev = this.v;
    this.v = v;
    if (prev && prev.state.game !== v.state.game) this.chains.clear();
    if (v.task?.input && (v.task.input.text != null || v.task.input.drawing != null)) {
      this.inputs.set(v.task.input.key, v.task.input);
      this.api.have = v.task.input.key;
    }
    this.renderPlayers();
    this.sync();
  }

  /** Screen changes run one at a time (they animate the camera); only the latest view counts. */
  private sync() {
    if (this.queued) return;
    this.queued = true;
    this.running = this.running.then(async () => {
      this.queued = false;
      try {
        await this.apply();
      } catch (err) {
        console.error(err);
      }
    });
  }

  private screenFor(v: RoomView): Screen {
    const st = v.state;
    if (st.phase === "lobby") return "lobby";
    if (st.phase === "reveal") return "reveal";
    if (st.phase === "done") return "done";
    const t = v.task;
    if (!t || t.done) return "wait";
    if (t.step > 0 && !this.inputs.has(t.input?.key ?? "")) return "wait"; // the input comes with the next poll
    return t.kind;
  }

  private keyOf = (v: RoomView) => `${v.state.game}:${v.state.phase}:${v.state.step}`;

  private async apply() {
    const v = this.v;
    if (!v || !this.active || this.host.inWall()) return;
    const screen = this.screenFor(v);
    const key = this.keyOf(v);
    const changed = screen !== this.screen || key !== this.stepKey;
    if (changed) {
      const from = this.screen;
      this.screen = screen;
      this.stepKey = key;
      await this.enter(screen, from, v);
    }
    await this.update(screen, v);
  }

  /** Which panel shows (body[data-rl]). */
  private show(s: Screen) {
    document.body.dataset.rl = s;
  }

  /** One-time setup of a screen. */
  private async enter(screen: Screen, from: Screen | null, v: RoomView) {
    const t = v.task;
    if (this.drawing && screen !== "draw") {
      this.drawing = false;
      this.host.stopDrawing();
    }
    this.card(null);
    this.prompt(null);
    $("rlQr").classList.toggle("show", screen === "lobby");
    const timed = screen === "write" || screen === "draw" || screen === "guess" || (screen === "wait" && v.state.phase === "play");
    if (timed) this.startTimer();
    else this.stopTimer();

    if (screen === "lobby") {
      this.show("lobby");
      this.picked = { chain: -1, item: -1 };
      if (from && from !== "join") await this.host.freshRock();
      this.showQr(v.code);
      return;
    }
    if (screen === "write") {
      this.show("write");
      this.askText("바위에 새길 이야기를 지어 주세요", "다음 사람이 이 문장을 새김으로 그려요", EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]);
      await this.host.freshRock();
      return;
    }
    if (screen === "draw") {
      const input = this.inputs.get(t!.input!.key)!;
      this.card("새길 이야기", input.text ?? "", input.from ? `${input.from} 님이 지었어요` : "");
      await Promise.all([this.host.freshRock(), sleep(2200)]);
      this.show("draw");
      this.host.startDrawing(false); // the tools appear under the card
      await sleep(600);
      if (this.v !== v && this.screenFor(this.v!) !== "draw") return;
      this.card(null);
      this.prompt(input.text ?? "", "이 이야기를 바위에 새겨 보세요");
      this.drawing = true;
      this.host.startDrawing(true);
      return;
    }
    if (screen === "guess") {
      const input = this.inputs.get(t!.input!.key)!;
      const empty = !input.drawing?.strokes.length;
      this.show("guess");
      this.askText(
        empty ? "빈 바위예요! 무엇이었을지 상상해 보세요" : "이 새김은 무엇일까요?",
        input.from ? `${input.from} 님이 새겼어요` : "",
        "보이는 대로 적어 보세요",
      );
      await this.host.showDrawing(empty ? null : input.drawing!, false);
      return;
    }
    if (screen === "wait") {
      this.show("wait");
      return;
    }
    if (screen === "reveal") {
      this.show("reveal");
      this.shownRv = "";
      return;
    }
    if (screen === "done") {
      this.show("done");
      this.picked = { chain: -1, item: -1 };
      $("rlAlbum").replaceChildren();
    }
  }

  /** Per-view updates of the current screen. */
  private async update(screen: Screen, v: RoomView) {
    const st = v.state;
    const isHost = st.host === v.me;
    if (screen === "lobby") {
      $("rlCodeShow").textContent = v.code;
      $("rlDevBadge").hidden = v.store !== "memory";
      const here = v.players.filter((p) => !p.away).length;
      const start = $<HTMLButtonElement>("rlStart");
      start.hidden = !isHost;
      start.disabled = here < RELAY.minPlayers;
      $("rlLobbyNote").textContent = isHost
        ? here < RELAY.minPlayers ? `${RELAY.minPlayers}명부터 시작할 수 있어요` : "모두 모였으면 시작!"
        : "방장이 시작하기를 기다리는 중…";
    }
    if (screen === "wait" && st.phase === "play") {
      const seated = v.players.filter((p) => p.seat >= 0);
      $("rlWaitCount").textContent = `${seated.filter((p) => p.done).length}/${st.n}`;
    }
    if (screen === "reveal") await this.updateReveal(v);
    if (screen === "done") this.updateDone(v);
  }

  private renderPlayers() {
    const v = this.v!;
    const playing = v.state.phase === "play";
    for (const id of ["rlPlayers", "rlWaitPlayers"]) {
      const ul = $(id);
      const list = id === "rlWaitPlayers" ? v.players.filter((p) => p.seat >= 0) : v.players;
      ul.replaceChildren(
        ...list.map((p) => {
          const li = el("li", "", p.name);
          li.classList.toggle("me", p.id === v.me);
          li.classList.toggle("away", p.away);
          li.classList.toggle("done", playing && p.done);
          if (p.id === v.state.host) li.append(el("small", "", "방장"));
          return li;
        }),
      );
    }
  }

  // ---------------------------------------------------------------- write / guess / draw

  private askText(title: string, sub: string, placeholder: string) {
    const ask = $("rlAsk");
    ask.replaceChildren(document.createTextNode(title), ...(sub ? [el("small", "", sub)] : []));
    const input = $<HTMLInputElement>("rlText");
    input.value = "";
    input.placeholder = placeholder;
    $("rlTextNote").textContent = "";
    $("rlTextNote").classList.remove("warn");
    $<HTMLButtonElement>("rlSend").disabled = false;
    this.syncCount();
  }

  private syncCount() {
    const input = $<HTMLInputElement>("rlText");
    const chars = [...input.value];
    if (chars.length > RELAY.textMax) input.value = chars.slice(0, RELAY.textMax).join("");
    $("rlTextCount").textContent = `${Math.min(chars.length, RELAY.textMax)}/${RELAY.textMax}`;
  }

  /**
   * Sends this step's answer. The screen stays until the server confirms (its view then shows
   * 기다리는 중), so a refused text or a network error leaves the answer in place to retry.
   * `final` = the time is up: no second chance for the text, and network errors are retried.
   */
  private async submit(final: boolean) {
    const v = this.v;
    if (!v?.task || v.task.done || v.state.phase !== "play") return;
    const key = this.keyOf(v);
    if (this.sending === key) return;
    const screen = this.screen, step = v.task.step;
    const send = $<HTMLButtonElement>("rlSend"), note = $("rlTextNote");
    let payload: { text?: string; drawing?: RelayDrawing };
    if (screen === "draw") {
      this.drawing = false;
      payload = { drawing: this.host.stopDrawing() };
    } else if (screen === "write" || screen === "guess") {
      payload = { text: $<HTMLInputElement>("rlText").value };
      send.disabled = true;
      note.classList.remove("warn");
      note.textContent = "보내는 중…";
    } else return;
    this.sending = key;
    const retry = () => {
      this.sending = "";
      if (screen === "draw" && this.screen === "draw") {
        this.drawing = true;
        this.host.startDrawing(true);
      }
      send.disabled = false;
      if (note.textContent === "보내는 중…") note.textContent = "";
    };
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await this.api.submit(step, payload, final)) === "text") {
          retry();
          note.textContent = "모두가 보는 말이에요. 다른 말로 적어 주세요.";
          note.classList.add("warn");
        }
        return;
      } catch (err) {
        if (!final || attempt >= 3 || (err instanceof RoomError && err.code !== "network")) {
          retry();
          toast("보내지 못했어요. 다시 눌러 주세요");
          return;
        }
        await sleep(1000);
      }
    }
  }

  /** Called by the 다 그렸어요 button. */
  finishDrawing() {
    if (this.drawing) void this.submit(false);
  }

  // ---------------------------------------------------------------- timer

  private startTimer() {
    if (this.timerRaf) return;
    const timer = $("timer"), num = $("timerNum"), bar = $("timerBar"), label = $("timerLabel");
    timer.classList.add("show");
    document.body.classList.add("rl-timer");
    const tick = () => {
      const v = this.v;
      if (!v || v.state.phase !== "play") return this.stopTimer();
      const total = (RELAY.seconds[v.task?.kind ?? "write"] + RELAY.leadSeconds) * 1000;
      const left = Math.max(0, v.state.deadline - this.api.now());
      const shown = Math.min(left, total - RELAY.leadSeconds * 1000);
      label.textContent = this.screen === "wait" ? "기다리는 중" : TIMER_LABEL[v.task?.kind ?? "write"];
      num.textContent = String(Math.ceil(shown / 1000));
      bar.style.transform = `scaleX(${Math.min(1, left / total)})`;
      timer.classList.toggle("warn", this.screen !== "wait" && left <= 5000);
      if (left <= 0 && (this.screen === "write" || this.screen === "draw" || this.screen === "guess")) void this.submit(true);
      if (left <= 0 && this.screen === "wait") this.api.pollNow();
      this.timerRaf = window.setTimeout(tick, left <= 0 ? 1000 : 200);
    };
    tick();
  }

  private stopTimer() {
    clearTimeout(this.timerRaf);
    this.timerRaf = 0;
    $("timer").classList.remove("show", "warn");
    document.body.classList.remove("rl-timer");
  }

  // ---------------------------------------------------------------- reveal (host-driven)

  private async loadChain(game: number, chain: number, need: number): Promise<ChainEntry[]> {
    const key = `${game}:${chain}`;
    let list = this.chains.get(key);
    if (!list || list.length < need) {
      list = await this.api.chain(chain);
      this.chains.set(key, list);
    }
    return list;
  }

  private ownerName(v: RoomView, chain: number) {
    return v.players.find((p) => p.seat === chain)?.name ?? `${chain + 1}번`;
  }

  private async updateReveal(v: RoomView) {
    const st = v.state;
    const [chain, step] = revealAt(st);
    const isHost = st.host === v.me;
    const next = $<HTMLButtonElement>("rlNext");
    next.hidden = !isHost;
    next.textContent = step < st.n - 1 ? "다음" : chain < st.n - 1 ? "다음 이야기" : "끝";
    $("rlRevTitle").textContent = `${this.ownerName(v, chain)} 님의 이야기`;
    $("rlRevPos").textContent = `이야기 ${chain + 1}/${st.n}`;
    $("rlRevNote").textContent = isHost ? "" : "방장이 넘겨요";

    const key = `${st.game}:${st.rv}`;
    if (this.shownRv === key) return;
    next.disabled = true;
    let entries: ChainEntry[];
    try {
      entries = await this.loadChain(st.game, chain, step + 1);
    } catch {
      next.disabled = false;
      return; // the next poll tries again
    }
    const e = entries.find((x) => x.step === step);
    this.shownRv = key;
    this.feed($("rlFeed"), entries.filter((x) => x.step <= step), step);
    if (step === 0) await this.host.freshRock();
    if (e) await this.showEntry(e, true);
    if (this.v?.state.rv === st.rv) next.disabled = false;
  }

  private async showEntry(e: ChainEntry, timelapse: boolean) {
    if (e.drawing) {
      this.card(null);
      await this.host.showDrawing(e.drawing.strokes.length ? e.drawing : null, timelapse);
      if (!e.drawing.strokes.length) this.card(`${e.name || "누군가"} 님의 새김`, "(빈 바위)", "시간 안에 새기지 못했어요");
    } else {
      const label = e.step === 0 ? `${e.name || "누군가"} 님의 이야기` : `${e.name || "누군가"} 님의 추측`;
      this.card(label, e.text ?? "", e.auto ? (e.step === 0 ? "(자동으로 정한 이야기)" : "(시간 안에 적지 못했어요)") : "");
    }
  }

  private feed(ol: HTMLElement, entries: ChainEntry[], now: number, clickable = false) {
    ol.replaceChildren(
      ...entries.map((e, i) => {
        const li = el("li", e.drawing ? "draw" : "");
        li.append(el("span", "", e.drawing ? (e.drawing.strokes.length ? "새김" : "(빈 바위)") : `“${e.text ?? ""}”`), el("small", "", e.name || "자동"));
        li.classList.toggle("now", e.step === now);
        if (clickable) li.dataset.i = String(i);
        return li;
      }),
    );
    ol.lastElementChild?.scrollIntoView({ block: "nearest" });
  }

  // ---------------------------------------------------------------- done: album + the shared wall

  private updateDone(v: RoomView) {
    const st = v.state;
    const isHost = st.host === v.me;
    const chips = $("rlChains");
    if (chips.childElementCount !== st.n) {
      chips.replaceChildren(
        ...Array.from({ length: st.n }, (_, c) => {
          const b = el("button", "", `${this.ownerName(v, c)} 님의 이야기`);
          b.dataset.chain = String(c);
          return b;
        }),
      );
    }
    [...chips.children].forEach((b, c) => b.setAttribute("aria-pressed", String(c === this.picked.chain)));
    const marks = Object.values(st.carved);
    const placed = marks.filter((m) => Array.isArray(m)).length;
    const left = st.n - marks.length;
    const note = $("rlCarveNote");
    if (this.carving) note.textContent = "벽에 새기는 중…";
    else if (!marks.length) note.textContent = isHost ? "이야기를 눌러 다시 보거나, 모두의 벽에 남겨 보세요." : "이야기를 눌러 다시 볼 수 있어요.";
    else note.textContent = `모두의 벽에 ${placed}개를 남겼어요${marks.length - placed ? ` · ${marks.length - placed}개는 남기지 못했어요` : ""}`;
    const carve = $<HTMLButtonElement>("rlCarve");
    carve.hidden = !isHost || left === 0;
    carve.disabled = this.carving;
    $("rlWall").hidden = placed === 0;
    $("rlAgain").hidden = !isHost;
  }

  private async pickChain(chain: number) {
    const v = this.v;
    if (!v || v.state.phase !== "done") return;
    const entries = await this.loadChain(v.state.game, chain, v.state.n).catch(() => null);
    if (!entries) return toast("불러오지 못했어요");
    this.picked = { chain, item: -1 };
    this.feed($("rlAlbum"), entries, -1, true);
    this.updateDone(v);
    // Start on the chain's last drawing, with its first text over it.
    const lastDrawing = [...entries].reverse().find((e) => e.drawing?.strokes.length);
    await this.host.showDrawing(lastDrawing?.drawing ?? null, false);
    const first = entries[0];
    if (first) this.card(`${first.name || "누군가"} 님의 이야기`, first.text ?? "", "");
  }

  private async pickItem(i: number) {
    const v = this.v;
    if (!v || this.picked.chain < 0) return;
    const entries = this.chains.get(`${v.state.game}:${this.picked.chain}`);
    const e = entries?.[i];
    if (!e) return;
    this.picked.item = i;
    [...$("rlAlbum").children].forEach((li, k) => li.classList.toggle("picked", k === i));
    await this.showEntry(e, false);
  }

  private async carveAll() {
    const v = this.v;
    if (!v || v.state.phase !== "done" || this.carving) return;
    if (!(await this.host.nearSite())) return;
    this.carving = true;
    this.updateDone(v);
    let full = false, failed = 0;
    let first: Rect | null = null;
    try {
      for (let c = 0; c < v.state.n; c++) {
        if (this.v!.state.carved[c]) continue;
        const entries = await this.loadChain(v.state.game, c, v.state.n);
        const strip = chainStrip(entries.flatMap((e) => (e.drawing ? [e.drawing] : [])));
        let rect: Rect = [0, 0, 0, 0], png = "";
        if (strip) {
          const spot = await this.host.stripSpot(strip);
          if (!spot) {
            full = true;
            break;
          }
          rect = spot;
          png = this.host.stripPNG(strip) ?? "";
        }
        const res = await this.api.carve(c, rect, png).catch(() => ({ ok: false, reason: "error" }) as const);
        if (res.ok && "draft" in res && res.mode === "mock" && res.draft) this.host.keepLocal(res.draft);
        if (res.ok) first ??= rect;
        else if (res.reason === "error") failed++;
      }
    } finally {
      this.carving = false;
    }
    await this.api.state().catch(() => {});
    if (full) await dialog("벽이 가득 찼어요", "지금은 빈자리가 없어요.\n남기지 못한 이야기도 있어요.", [{ label: "확인", value: 0, primary: true }]);
    else if (failed) toast("일부를 남기지 못했어요. 다시 눌러 주세요");
    else if (first) toast("모두의 벽에 새겼어요!");
  }

  private firstPlaced(): Rect | undefined {
    const marks = Object.values(this.v?.state.carved ?? {});
    return marks.find((m): m is Rect => Array.isArray(m));
  }

  // ---------------------------------------------------------------- overlays

  private card(label: string | null, text = "", from = "") {
    const card = $("rlCard");
    if (label == null) return card.classList.remove("show");
    $("rlCardLabel").textContent = label;
    $("rlCardText").textContent = text;
    $("rlCardFrom").textContent = from;
    card.classList.add("show");
  }

  private prompt(text: string | null, sub = "") {
    const p = $("rlPrompt");
    if (text == null) return p.classList.remove("show");
    p.replaceChildren(document.createTextNode(`“${text}”`), ...(sub ? [el("small", "", sub)] : []));
    p.classList.add("show");
  }

  private inviteUrl(code: string) {
    const u = new URL(location.href);
    u.search = `?room=${code}`;
    u.hash = "";
    return u.toString();
  }

  private async showQr(code: string) {
    $("rlQrCode").textContent = code;
    if (this.qrFor === code) return;
    this.qrFor = code;
    const { default: qrcode } = await import("qrcode-generator");
    const qr = qrcode(0, "M");
    qr.addData(this.inviteUrl(code));
    qr.make();
    $("rlQrImg").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  // ---------------------------------------------------------------- buttons

  private wire() {
    const name = $<HTMLInputElement>("rlName"), code = $<HTMLInputElement>("rlCode");
    const note = $("rlJoinNote");
    code.addEventListener("input", () => (code.value = code.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4)));
    const enter = async (how: "create" | "join") => {
      const n = name.value.trim();
      if (how === "join" && code.value.length !== 4) {
        note.textContent = "방 코드 4글자를 넣어 주세요";
        return code.focus();
      }
      saveName(n);
      note.textContent = how === "create" ? "방을 만드는 중…" : "들어가는 중…";
      for (const b of ["rlCreate", "rlJoin"]) $<HTMLButtonElement>(b).disabled = true;
      try {
        if (how === "create") await this.api.create(n);
        else await this.api.join(code.value, n);
        note.textContent = "";
        this.inputs.clear();
        this.chains.clear();
        await this.api.state();
        this.api.start();
      } catch (err) {
        note.textContent = JOIN_ERRORS[err instanceof RoomError ? err.code : ""] ?? "연결할 수 없어요. 잠시 후 다시 시도해 주세요.";
      } finally {
        for (const b of ["rlCreate", "rlJoin"]) $<HTMLButtonElement>(b).disabled = false;
      }
    };
    $("rlCreate").addEventListener("click", () => enter("create"));
    $("rlJoin").addEventListener("click", () => enter("join"));
    code.addEventListener("keydown", (e) => e.key === "Enter" && enter("join"));
    $("rlClose").addEventListener("click", () => this.close());
    for (const id of ["rlLeave", "rlQuit1", "rlQuit2", "rlQuit3", "rlExit"]) $(id).addEventListener("click", () => this.quit());

    $("rlInvite").addEventListener("click", async () => {
      const url = this.inviteUrl(this.v?.code ?? "");
      try {
        if (navigator.share) return void (await navigator.share({ title: "암각화몬 이어 그리기", text: `방 코드 ${this.v?.code}`, url }));
        await navigator.clipboard.writeText(url);
        toast("초대 주소를 복사했어요");
      } catch {
        // share sheet closed
      }
    });
    $("rlStart").addEventListener("click", async () => {
      const b = $<HTMLButtonElement>("rlStart");
      b.disabled = true;
      try {
        await this.api.act("start");
      } catch (err) {
        toast(err instanceof RoomError && err.code === "few" ? `${RELAY.minPlayers}명 이상 있어야 해요` : "시작하지 못했어요");
        b.disabled = false;
      }
    });

    const text = $<HTMLInputElement>("rlText");
    text.addEventListener("input", () => {
      this.syncCount();
      $("rlTextNote").classList.remove("warn");
      $("rlTextNote").textContent = "";
    });
    text.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && this.submit(false));
    $("rlSend").addEventListener("click", () => this.submit(false));

    $("rlNext").addEventListener("click", async () => {
      const v = this.v;
      if (!v) return;
      const b = $<HTMLButtonElement>("rlNext");
      b.disabled = true;
      await this.api.act("reveal", { rv: v.state.rv + 1 }).catch(() => (b.disabled = false));
    });

    $("rlChains").addEventListener("click", (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>("[data-chain]")?.dataset.chain;
      if (c != null) void this.pickChain(Number(c));
    });
    $("rlAlbum").addEventListener("click", (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
      if (i != null) void this.pickItem(Number(i));
    });
    $("rlCarve").addEventListener("click", () => this.carveAll());
    $("rlAgain").addEventListener("click", () => this.api.act("again").catch(() => toast("다시 시작하지 못했어요")));
    $("rlWall").addEventListener("click", () => {
      this.card(null);
      void this.host.showWall(this.firstPlaced());
    });
  }
}
