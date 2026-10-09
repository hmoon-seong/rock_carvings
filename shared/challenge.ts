// 도전 모드 settings and prompts (Bangudae motifs). Edit this file to tune the game.

export const CHALLENGE = {
  /** Drawing time in seconds (CLAUDE.md: 30 s, tune after playtesting). */
  seconds: 30,
  /** 3-2-1 before the timer starts. */
  countdown: 3,
  /** The last N seconds are emphasized. */
  warnSeconds: 5,
};

export interface Motif {
  id: string;
  /** Shown to the visitor. */
  label: string;
  /** For the scoring model. */
  en: string;
  /** One short line on the prompt card. */
  hint: string;
}

export const MOTIFS: Motif[] = [
  { id: "whale", label: "고래", en: "whale", hint: "반구대 바위의 주인공이에요." },
  { id: "whale_calf", label: "새끼 업은 고래", en: "a whale carrying its calf on its back", hint: "큰 고래 등 위에 작은 고래를 올려요." },
  { id: "deer", label: "사슴", en: "deer", hint: "긴 다리와 뿔을 잊지 마세요." },
  { id: "tiger", label: "호랑이", en: "tiger", hint: "줄무늬 몸통에 긴 꼬리." },
  { id: "boar", label: "멧돼지", en: "wild boar", hint: "통통한 몸에 짧은 다리." },
  { id: "human", label: "사람", en: "human figure", hint: "팔다리를 활짝 벌린 사람." },
  { id: "boat", label: "배", en: "boat with people (rowing boat)", hint: "고래를 잡으러 가는 배예요." },
  { id: "hunter", label: "작살 든 사람", en: "person holding a harpoon", hint: "긴 작살을 든 사냥꾼." },
  { id: "turtle", label: "거북", en: "turtle", hint: "둥근 등딱지와 네 발." },
  { id: "waterbird", label: "물새", en: "water bird", hint: "물 위에 뜬 새, 긴 목." },
];

export function motifById(id: string | null | undefined): Motif | undefined {
  return MOTIFS.find((m) => m.id === id);
}

/** A random motif, never `exclude` (so "다른 제시어" always changes). */
export function pickMotif(exclude?: string, rnd: () => number = Math.random): Motif {
  const pool = MOTIFS.filter((m) => m.id !== exclude);
  return pool[Math.floor(rnd() * pool.length) % pool.length];
}
