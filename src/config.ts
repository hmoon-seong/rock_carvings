// Wall metadata (public/wall/metadata.json) and the drawing palette → carving styles.

import type { CarveStyle } from "./carve/carve";

export interface WallMeta {
  width_mm: number;
  height_mm: number;
  detail_tile_mm: number;
  images: Record<string, { file: string; px?: [number, number]; rect_mm?: number[] }>;
  lighting: {
    default: {
      azimuth_deg: number;
      elevation_deg: number;
      sun_intensity: number;
      ambient_intensity: number;
      exposure: number;
      detail_strength: number;
    };
    sun_color: [number, number, number];
    sky_color: [number, number, number];
    ground_color: [number, number, number];
  };
  carving: CarveStyle & {
    drawing_width_mm: number;
    fresh_stone_lightening: number;
    demo_center_mm: [number, number];
  };
}

export const WALL_DIR = `${import.meta.env.BASE_URL}wall/`;

export async function loadMeta(): Promise<WallMeta> {
  const res = await fetch(WALL_DIR + "metadata.json");
  if (!res.ok) throw new Error(`metadata.json ${res.status}`);
  return res.json();
}

export interface PaletteColor {
  label: string;
  hex: string;
}

/** Lab sliders (실험실). They set the brown carving; purple follows at fixed ratios. */
export type LabSettings = CarveStyle;

export function defaultLab(meta: WallMeta): LabSettings {
  const c = meta.carving;
  return { depth_mm: c.depth_mm, bevel_sigma_mm: c.bevel_sigma_mm, peck_roughness: c.peck_roughness };
}

/** Purple relative to brown: shallower, slightly crisper, less pecked (5 / 3.0 / 0.5 at the defaults). */
const PURPLE_RATIO = { depth_mm: 5 / 12, bevel_sigma_mm: 3.0 / 3.8, peck_roughness: 0.5 / 0.79 };

export const PALETTE: PaletteColor[] = [
  { label: "갈색", hex: "#9d4a2c" },
  { label: "보라", hex: "#7c4c91" },
];

/** Brown = the main figures, deep 면새김; purple = a second group, shallower (as prototyped in the bake). */
export function carveStyles(lab: LabSettings): CarveStyle[] {
  return [
    { ...lab },
    {
      depth_mm: lab.depth_mm * PURPLE_RATIO.depth_mm,
      bevel_sigma_mm: lab.bevel_sigma_mm * PURPLE_RATIO.bevel_sigma_mm,
      peck_roughness: lab.peck_roughness * PURPLE_RATIO.peck_roughness,
    },
  ];
}

/** Carve layer resolution (WALL_ASSETS: about 1 mm/px). */
export const CARVE_MM_PER_PX = 1;
/** Brush diameter in mm: thick by default, like the book tracings. */
export const BRUSH_MM = { min: 8, max: 60, default: 22 };
/** Rubbing / tracing paper tone. */
export const PAPER_HEX = "#ece6dd";

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
