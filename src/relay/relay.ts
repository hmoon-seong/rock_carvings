// 이어 그리기 screens: join → lobby → (write → draw → guess …) → done (each player's album).
// Everyone plays every step at once (one chain each, passed one seat on per step); a player who
// has sent their answer waits for the others ("wait"). A watcher (관전) follows the chains as
// they grow ("watch"). At the end every player opens the album of the chain they started.
// The server decides which step the room is at (src/relay/api.ts polls it); this controller
// turns each room view into a screen. The rock itself (drawing, carving, camera) belongs to
// main.ts and is reached through RelayHost. Chains do not go on the shared wall (2026-10-29).

import { RELAY, stepKind, type RelayDrawing, type StepKind } from "../../shared/relay";
import { dialog, toast } from "../ui/notice";
import type { Album } from "./album";
import { RelayApi, RoomError, saveName, savedName, type ChainEntry, type RoomView } from "./api";
import type { Tutorial } from "./tutorial";

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
  /** Carves a drawing (null: bare rock) at the current spot and returns a w × h photo of it under the light. */
  photo(d: RelayDrawing | null, w: number, h: number): Promise<HTMLCanvasElement>;
}

type Screen = "join" | "lobby" | StepKind | "wait" | "watch" | "done";

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

/** Longest possible game with n players (minutes, rounded up): every step to its deadline. */
export function gameMinutes(n: number): number {
  let s = 0;
  for (let step = 0; step < n; step++) s += RELAY.seconds[stepKind(step)] + RELAY.leadSeconds;
  return Math.ceil(s / 60);
}

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
  /** Chains as far as fetched (key: game:chain). */
  private chains = new Map<string, ChainEntry[]>();
  /** Watchers: the chain being followed, and what of it the rock shows. */
  private watchChain = 0;
  private watchShown = "";
  private queued = false;
  private running: Promise<void> = Promise.resolve();
  private timerRaf = 0;
  private qrFor = "";
  /** Loaded on first use (not part of the first page load). */
  private album: Album | null = null;
  private albumP: Promise<Album> | null = null;
  private tutorialP: Promise<Tutorial> | null = null;

  constructor(private host: RelayHost) {
    this.api.onView = (v) => this.render(v);
    this.api.onLost = () => {
      if (!this.active) return;
      dialog("방이 닫혔어요", "이 방은 더 이상 없어요.", [{ label: "확인", value: 0, primary: true }]).then(() => this.close());
    };
    this.api.onTrouble = (bad) => bad && toast("연결이 불안정해요. 계속 다시 시도하는 중…", 3000);
    this.wire();
  }

  private getAlbum(): Promise<Album> {
    return (this.albumP ??= import("./album").then(({ Album }) => {
      this.album = new Album({
        photo: (d, w, h) => this.host.photo(d, w, h),
        load: (chain) => this.loadChain(this.v!.state.game, chain, this.v!.state.n),
      });
      return this.album;
    }));
  }

  private tutorial(): Promise<Tutorial> {
    return (this.tutorialP ??= import("./tutorial").then(({ Tutorial }) => new Tutorial()));
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
    void this.tutorial().then((t) => t.firstTime());
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
    this.stepKey = this.sending = this.watchShown = "";
    this.stopTimer();
    this.card(null);
    this.prompt(null);
    this.album?.close();
    $("rlQr").classList.remove("show");
    delete document.body.dataset.rl;
    this.onActive();
    await this.host.exit();
  }

  /** 나가기 (with a confirmation while playing). */
  async quit() {
    const v = this.v;
    if (v && v.state.phase === "play" && !this.me(v)?.watch) {
      const go = await dialog("게임에서 나갈까요?", "내 차례는 자동으로 채워져요.\n같은 방에 다시 들어올 수는 없어요.", [
        { label: "계속하기", value: false },
        { label: "나가기", value: true, primary: true },
      ]);
      if (!go) return;
    }
    await this.api.leave();
    await this.close();
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

  private me = (v: RoomView) => v.players.find((p) => p.id === v.me);
  /** The player who started `chain` (seat s starts chain s). */
  private ownerName = (v: RoomView, chain: number) => v.players.find((p) => p.seat === chain && !p.watch)?.name ?? `${chain + 1}번`;

  private screenFor(v: RoomView): Screen {
    const st = v.state;
    if (st.phase === "lobby") return "lobby";
    if (st.phase === "done") return "done";
    if (this.me(v)?.watch) return "watch";
    const t = v.task;
    if (!t || t.done) return "wait";
    if (t.step > 0 && !this.inputs.has(t.input?.key ?? "")) return "wait"; // the input comes with the next poll
    return t.kind;
  }

  private keyOf = (v: RoomView) => `${v.state.game}:${v.state.phase}:${v.state.step}`;

  private async apply() {
    const v = this.v;
    if (!v || !this.active) return;
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
    if (screen !== "done") this.album?.close();
    $("rlQr").classList.toggle("show", screen === "lobby");
    const timed = screen === "write" || screen === "draw" || screen === "guess" || screen === "watch" || (screen === "wait" && v.state.phase === "play");
    if (timed) this.startTimer();
    else this.stopTimer();

    if (screen === "lobby") {
      this.show("lobby");
      if (from && from !== "join") await this.host.freshRock();
      this.showQr(v.code);
      return;
    }
    if (screen === "write") {
      this.show("write");
      this.askText("바위에 새길 이야기를 지어 주세요", "옆 사람이 이 문장을 그림으로 새겨요", EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]);
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
      this.prompt(input.text ?? "", v.state.step === 1 ? "글자 없이 그림으로만 새겨 주세요" : "이 이야기를 바위에 새겨 보세요");
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
        input.from ? `${input.from} 님이 새겼어요${v.state.step === 2 ? " · 보이는 대로 적으면 돼요" : ""}` : "",
        "보이는 대로 적어 보세요",
      );
      await this.host.showDrawing(empty ? null : input.drawing!, false);
      return;
    }
    if (screen === "wait") {
      this.show("wait");
      return;
    }
    if (screen === "watch") {
      this.show("watch");
      if (from !== "watch") this.watchChain = 0;
      this.watchShown = "";
      this.renderWatchTabs(v);
      if (v.state.step === 0) await this.host.freshRock();
      return;
    }
    if (screen === "done") {
      this.show("done");
      const me = this.me(v);
      const mine = me && !me.watch && me.seat >= 0 ? me.seat : null;
      const album = await this.getAlbum();
      if (this.screen !== "done") return;
      album.open({
        game: v.state.game,
        n: v.state.n,
        owners: Array.from({ length: v.state.n }, (_, c) => this.ownerName(v, c)),
        mine,
      });
    }
  }

  /** Per-view updates of the current screen. */
  private async update(screen: Screen, v: RoomView) {
    const st = v.state;
    const isHost = st.host === v.me;
    if (screen === "lobby") {
      $("rlCodeShow").textContent = v.code;
      $("rlDevBadge").hidden = v.store !== "memory";
      const here = v.players.filter((p) => !p.away && !p.watch).length;
      const watching = !!this.me(v)?.watch;
      const start = $<HTMLButtonElement>("rlStart");
      start.hidden = !isHost;
      start.disabled = here < RELAY.minPlayers;
      const role = $<HTMLButtonElement>("rlRole");
      role.hidden = isHost;
      role.textContent = watching ? "참가하기" : "관전하기";
      const n = Math.max(here, RELAY.minPlayers);
      $("rlLobbyInfo").textContent = `${n}명이면 이야기 ${n}개 · 한 판 최대 ${gameMinutes(n)}분`;
      $("rlLobbyNote").textContent = isHost
        ? here < RELAY.minPlayers ? `${RELAY.minPlayers}명부터 시작할 수 있어요` : "모두 모였으면 시작!"
        : watching ? "관전 중이에요. 참가하기를 누르면 함께 그려요" : "방장이 시작하기를 기다리는 중…";
    }
    if (screen === "wait" && st.phase === "play") {
      const seated = v.players.filter((p) => p.seat >= 0 && !p.watch);
      $("rlWaitCount").textContent = `${seated.filter((p) => p.done).length}/${st.n}`;
    }
    if (screen === "watch") await this.updateWatch(v);
    if (screen === "done") this.updateDone(v);
  }

  private renderPlayers() {
    const v = this.v!;
    const playing = v.state.phase === "play";
    const item = (p: RoomView["players"][number]) => {
      const li = el("li", "", p.name);
      li.classList.toggle("me", p.id === v.me);
      li.classList.toggle("away", p.away);
      li.classList.toggle("done", playing && p.done);
      if (p.id === v.state.host) li.append(el("small", "", "방장"));
      else if (p.watch) li.append(el("small", "", "관전"));
      return li;
    };
    $("rlPlayers").replaceChildren(...v.players.map(item));
    $("rlWaitPlayers").replaceChildren(...v.players.filter((p) => p.seat >= 0 && !p.watch).map(item));
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
      const kind = stepKind(v.state.step);
      const total = (RELAY.seconds[kind] + RELAY.leadSeconds) * 1000;
      const left = Math.max(0, v.state.deadline - this.api.now());
      const shown = Math.min(left, total - RELAY.leadSeconds * 1000);
      const mine = this.screen !== "wait" && this.screen !== "watch";
      label.textContent = this.screen === "wait" ? "기다리는 중" : this.screen === "watch" ? "관전 중" : TIMER_LABEL[kind];
      num.textContent = String(Math.ceil(shown / 1000));
      bar.style.transform = `scaleX(${Math.min(1, left / total)})`;
      timer.classList.toggle("warn", mine && left <= 5000);
      if (left <= 0 && mine) void this.submit(true);
      if (left <= 0 && !mine) this.api.pollNow();
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

  // ---------------------------------------------------------------- chains: watch

  /** Chain `chain` of `game` with at least `need` entries (fetched again when shorter). */
  private async loadChain(game: number, chain: number, need: number): Promise<ChainEntry[]> {
    const key = `${game}:${chain}`;
    let list = this.chains.get(key);
    if (!list || list.length < need) {
      list = await this.api.chain(chain);
      this.chains.set(key, list);
    }
    return list;
  }

  private renderWatchTabs(v: RoomView) {
    const tabs = $("rlWatchTabs");
    tabs.replaceChildren(
      ...Array.from({ length: v.state.n }, (_, c) => {
        const b = el("button", "", `${this.ownerName(v, c)} 님`);
        b.dataset.chain = String(c);
        b.setAttribute("aria-pressed", String(c === this.watchChain));
        return b;
      }),
    );
  }

  /** Watchers: the followed chain's last finished step on the rock, and the chain so far. */
  private async updateWatch(v: RoomView) {
    const st = v.state;
    const chain = this.watchChain;
    $("rlWatchTitle").textContent = `${this.ownerName(v, chain)} 님의 이야기`;
    $("rlWatchPos").textContent = `관전 중 · ${st.step + 1}/${st.n}단계 · ${stepKind(st.step) === "draw" ? "새기는 중" : stepKind(st.step) === "guess" ? "맞히는 중" : "이야기 짓는 중"}`;
    const key = `${st.game}:${chain}:${st.step}`;
    if (this.watchShown === key) return;
    this.watchShown = key;
    if (st.step === 0) {
      $("rlWatchFeed").replaceChildren();
      return;
    }
    let entries: ChainEntry[];
    try {
      entries = await this.loadChain(st.game, chain, st.step);
    } catch {
      this.watchShown = ""; // the next poll tries again
      return;
    }
    const done = entries.filter((e) => e.step < st.step);
    this.feed($("rlWatchFeed"), done, st.step - 1);
    const last = done[done.length - 1];
    if (last && this.watchShown === key) await this.showEntry(last, true);
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

  private feed(ol: HTMLElement, entries: ChainEntry[], now: number) {
    ol.replaceChildren(
      ...entries.map((e) => {
        const li = el("li", e.drawing ? "draw" : "");
        li.append(el("span", "", e.drawing ? (e.drawing.strokes.length ? "새김" : "(빈 바위)") : `“${e.text ?? ""}”`), el("small", "", e.name || "자동"));
        li.classList.toggle("now", e.step === now);
        return li;
      }),
    );
    ol.lastElementChild?.scrollIntoView({ block: "nearest" });
  }

  // ---------------------------------------------------------------- done: albums

  private updateDone(v: RoomView) {
    $("rlAgain").hidden = v.state.host !== v.me;
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
    const buttons = ["rlCreate", "rlJoin", "rlWatch"];
    const enter = async (how: "create" | "join" | "watch") => {
      const n = name.value.trim();
      if (how !== "create" && code.value.length !== 4) {
        note.textContent = "방 코드 4글자를 넣어 주세요";
        return code.focus();
      }
      saveName(n);
      note.textContent = how === "create" ? "방을 만드는 중…" : "들어가는 중…";
      for (const b of buttons) $<HTMLButtonElement>(b).disabled = true;
      try {
        if (how === "create") await this.api.create(n);
        else await this.api.join(code.value, n, how === "watch");
        note.textContent = "";
        this.inputs.clear();
        this.chains.clear();
        await this.api.state();
        this.api.start();
      } catch (err) {
        const e = err instanceof RoomError ? err.code : "";
        note.textContent =
          (how === "watch" && e === "full" ? "관전석이 꽉 찼어요." : JOIN_ERRORS[e]) ?? "연결할 수 없어요. 잠시 후 다시 시도해 주세요.";
        if (how === "join" && (e === "started" || e === "full")) {
          for (const b of buttons) $<HTMLButtonElement>(b).disabled = false;
          const watch = await dialog(e === "started" ? "이미 시작한 방이에요" : "방이 꽉 찼어요", "관전으로 들어가서 구경할 수 있어요.", [
            { label: "취소", value: false },
            { label: "관전하기", value: true, primary: true },
          ]);
          if (watch) return enter("watch");
        }
      } finally {
        for (const b of buttons) $<HTMLButtonElement>(b).disabled = false;
      }
    };
    $("rlCreate").addEventListener("click", () => enter("create"));
    $("rlJoin").addEventListener("click", () => enter("join"));
    $("rlWatch").addEventListener("click", () => enter("watch"));
    code.addEventListener("keydown", (e) => e.key === "Enter" && enter("join"));
    $("rlClose").addEventListener("click", () => this.close());
    for (const id of ["rlLeave", "rlQuit1", "rlQuit2", "rlQuit4", "rlExit"]) $(id).addEventListener("click", () => this.quit());
    for (const id of ["rlRules", "rlRules2"]) $(id).addEventListener("click", () => void this.tutorial().then((t) => t.open()));
    $("rlRole").addEventListener("click", async () => {
      const v = this.v;
      if (!v) return;
      const b = $<HTMLButtonElement>("rlRole");
      b.disabled = true;
      try {
        await this.api.act("role", { watch: !this.me(v)?.watch });
      } catch (err) {
        toast(err instanceof RoomError && err.code === "full" ? "자리가 꽉 찼어요" : "바꾸지 못했어요");
      } finally {
        b.disabled = false;
      }
    });

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

    $("rlWatchTabs").addEventListener("click", (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>("[data-chain]")?.dataset.chain;
      const v = this.v;
      if (c == null || !v) return;
      this.watchChain = Number(c);
      this.watchShown = "";
      this.renderWatchTabs(v);
      this.sync();
    });
    $("rlSave").addEventListener("click", () => void this.album?.save());
    $("rlAgain").addEventListener("click", () => this.api.act("again").catch(() => toast("다시 시작하지 못했어요")));
  }
}
