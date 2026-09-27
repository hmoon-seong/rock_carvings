// 도면 (tracing) view: the carved shape as flat color silhouettes, like the book tracings.
// Each color's mask is softened by its bevel and cut at half height, so the outline is the
// rounded shape the stone actually got, not the raw brush strokes.

import { gaussBlur } from "./blur";

/** Label per pixel: palette index of the silhouette, or -1 for bare paper. */
export function tracingLabels(masks: Float32Array[], sigmasPx: number[], w: number, h: number): Int8Array {
  const labels = new Int8Array(w * h).fill(-1);
  const best = new Float32Array(w * h).fill(0.5);
  masks.forEach((mask, c) => {
    const soft = gaussBlur(mask, w, h, sigmasPx[c]);
    for (let i = 0; i < soft.length; i++) {
      if (soft[i] > best[i]) {
        best[i] = soft[i];
        labels[i] = c;
      }
    }
  });
  return labels;
}
