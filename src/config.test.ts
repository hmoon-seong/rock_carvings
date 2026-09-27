import { describe, expect, it } from "vitest";
import { carveStyles, DEFAULT_LIGHT, defaultLab, sunColor } from "./config";
import look from "./look.json";

describe("lab settings", () => {
  it("takes the defaults from look.json (the format 설정 복사 copies)", () => {
    const lab = defaultLab();
    expect(lab).toMatchObject({ depth_mm: 6.5, bevel_sigma_mm: 4.5, peck_roughness: 0.18, sun_warmth: 0.54, exposure: 1.17 });
    expect(lab).not.toHaveProperty("azimuth_deg");
    expect(DEFAULT_LIGHT).toEqual({ azimuth: look.azimuth_deg, elevation: look.elevation_deg });
  });

  it("derives purple from brown: own depth ratio, fixed bevel and peck ratios", () => {
    const [brown, purple] = carveStyles(defaultLab());
    expect(brown).toEqual({ depth_mm: 6.5, bevel_sigma_mm: 4.5, peck_roughness: 0.18 });
    expect(purple.depth_mm).toBeCloseTo(6.5 * 0.39);
    expect(purple.bevel_sigma_mm).toBeCloseTo(4.5 * (3.0 / 3.8));
    expect(purple.peck_roughness).toBeCloseTo(0.18 * (0.5 / 0.79));
  });
});

describe("sunColor", () => {
  const base: [number, number, number] = [1, 0.96, 0.9];
  it("returns the metadata color at warmth 0", () => expect(sunColor(base, 0)).toEqual(base));
  it("warms toward orange and cools toward blue", () => {
    const warm = sunColor(base, 1), cool = sunColor(base, -1);
    expect(warm[2]).toBeLessThan(base[2]);
    expect(cool[2]).toBeGreaterThan(base[2]);
    expect(cool[0]).toBeLessThan(base[0]);
  });
});
