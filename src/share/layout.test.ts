import { describe, expect, it } from "vitest";
import { koreanDate, shareCrop, wrapBalanced, wrapText } from "./layout";

const measure = (s: string) => [...s].length * 10;

describe("shareCrop", () => {
  it("keeps the aspect and contains the carving above the text band", () => {
    const bbox: [number, number, number, number] = [2000, 1500, 600, 400];
    const [x, y, w, h] = shareCrop(bbox, 10000, 4600, 1080 / 1920, 0.3);
    expect(w / h).toBeCloseTo(1080 / 1920, 6);
    expect(x).toBeLessThanOrEqual(2000);
    expect(x + w).toBeGreaterThanOrEqual(2600);
    expect(y).toBeLessThanOrEqual(1500);
    expect(1900).toBeLessThanOrEqual(y + h * 0.7); // carving bottom above the text band
  });
  it("stays on the wall near an edge", () => {
    const [x, y] = shareCrop([10, 10, 300, 300], 10000, 4600, 1, 0.38);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });
});

describe("wrapText", () => {
  it("wraps on spaces and breaks long words", () => {
    expect(wrapText("가나 다라 마바", 50, measure)).toEqual(["가나 다라", "마바"]);
    expect(wrapText("가나다라마바사아", 30, measure)).toEqual(["가나다", "라마바", "사아"]);
  });
  it("balances line lengths", () => {
    const lines = wrapBalanced("반구대에서 고래를 새겼어요! 우리 가족 여름 여행", 200, measure);
    expect(lines.length).toBe(2);
    expect(Math.abs(lines[0].length - lines[1].length)).toBeLessThanOrEqual(4);
  });
});

describe("koreanDate", () => {
  it("formats like 2026. 10. 9.", () => expect(koreanDate(new Date(2026, 9, 9))).toBe("2026. 10. 9."));
});
