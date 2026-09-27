// Wall texture loading. The overview pair + detail is the first-visit budget (291 KB);
// the full-res pair (1.2 MB) streams in afterwards.

import { WALL_DIR, type WallMeta } from "../config";

export interface WallImages {
  normal: ImageBitmap;
  albedo: ImageBitmap;
}

export async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  // No premultiply (AO lives in albedo alpha), no color management (normal maps).
  return createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}

export async function loadOverview(meta: WallMeta): Promise<WallImages & { detail: ImageBitmap }> {
  const f = (k: string) => WALL_DIR + meta.images[k].file;
  const [normal, albedo, detail] = await Promise.all([
    loadBitmap(f("overview_normal")),
    loadBitmap(f("overview_albedo")),
    loadBitmap(f("detail_normal")),
  ]);
  return { normal, albedo, detail };
}

export async function loadFull(meta: WallMeta): Promise<WallImages> {
  const f = (k: string) => WALL_DIR + meta.images[k].file;
  const [normal, albedo] = await Promise.all([loadBitmap(f("full_normal")), loadBitmap(f("full_albedo"))]);
  return { normal, albedo };
}
