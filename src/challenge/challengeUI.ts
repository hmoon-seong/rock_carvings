// 도전 모드 overlays: prompt card, 3-2-1 countdown and the drawing timer.

import { CHALLENGE, type Motif } from "../../shared/challenge";

const $ = (id: string) => document.getElementById(id)!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type TimerEnd = "timeup" | "done" | "quit";

export class ChallengeUI {
  private card = $("card");
  private countEl = $("countdown");
  private timerEl = $("timer");
  private timerNum = $("timerNum");
  private timerBar = $("timerBar");
  private stopTimer: ((why: TimerEnd) => void) | null = null;

  showCard(m: Motif) {
    $("cardLabel").textContent = m.label;
    $("cardHint").textContent = m.hint;
    $("cardTime").textContent = `${CHALLENGE.seconds}초`;
    this.card.classList.add("show");
  }

  hideCard() {
    this.card.classList.remove("show");
  }

  get cardOpen() {
    return this.card.classList.contains("show");
  }

  async countdown(n = CHALLENGE.countdown) {
    const el = this.countEl;
    el.classList.add("show");
    for (let i = n; i >= 1; i--) {
      el.textContent = String(i);
      el.classList.remove("tick");
      void el.offsetWidth; // restart the animation
      el.classList.add("tick");
      await wait(800);
    }
    el.classList.remove("show", "tick");
  }

  /** Runs the timer; resolves when time is up, or with finish()'s reason. */
  runTimer(m: Motif, seconds = CHALLENGE.seconds): Promise<TimerEnd> {
    $("timerLabel").textContent = m.label;
    this.timerEl.classList.add("show");
    this.timerEl.classList.remove("warn");
    const t0 = performance.now();
    return new Promise((resolve) => {
      let raf = 0;
      const end = (why: TimerEnd) => {
        cancelAnimationFrame(raf);
        this.stopTimer = null;
        this.timerEl.classList.remove("show", "warn");
        resolve(why);
      };
      this.stopTimer = end;
      const tick = () => {
        const left = Math.max(0, seconds - (performance.now() - t0) / 1000);
        this.timerNum.textContent = String(Math.ceil(left));
        this.timerBar.style.transform = `scaleX(${left / seconds})`;
        this.timerEl.classList.toggle("warn", left <= CHALLENGE.warnSeconds);
        if (left <= 0) end("timeup");
        else raf = requestAnimationFrame(tick);
      };
      tick();
    });
  }

  get running() {
    return this.stopTimer != null;
  }

  finish(why: TimerEnd) {
    this.stopTimer?.(why);
  }
}
