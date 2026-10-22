import { describe, expect, it } from "vitest";
import { carveStyles, DEFAULT_LIGHT, defaultLab, sunColor } from "./config";
import look from "./look.json";

describe("lab settings", () => {
  it("takes the defaults from look.json (the format 설정 복사 copies)", () => {
    const lab = defaultLab();
    const { depth_mm, bevel_sigma_mm, peck_roughness, sun_warmth, exposure } = look;
    expect(lab).toMatchObject({ depth_mm, bevel_sigma_mm, peck_roughness, sun_warmth, exposure });
    expect(lab).not.toHaveProperty("azimuth_deg");
    expect(DEFAULT_LIGHT).toEqual({ azimuth: look.azimuth_deg, elevation: look.elevation_deg });
  });

  it("derives purple from brown: own depth ratio, fixed bevel and peck ratios", () => {
    const [brown, purple] = carveStyles(defaultLab());
    const { depth_mm, bevel_sigma_mm, peck_roughness } = look;
    expect(brown).toEqual({ depth_mm, bevel_sigma_mm, peck_roughness });
    expect(purple.depth_mm).toBeCloseTo(depth_mm * look.purple_depth_ratio);
    expect(purple.bevel_sigma_mm).toBeCloseTo(bevel_sigma_mm * (3.0 / 3.8));
    expect(purple.peck_roughness).toBeCloseTo(peck_roughness * (0.5 / 0.79));
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
