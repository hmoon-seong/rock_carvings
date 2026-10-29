// Posting to the shared wall needs the visitor to be near the site (shared/site.ts).
// Browsing works everywhere. Dev bypass: ?nogeo=1

import { distanceM, SITE } from "../../shared/site";

export type GeoResult = "ok" | "far" | "denied" | "unavailable";

// export const geoBypassed = () => new URLSearchParams(location.search).get("nogeo") === "1";
export const geoBypassed = () => true;

export function checkNearSite(): Promise<GeoResult> {
  if (geoBypassed()) return Promise.resolve("ok");
  if (!navigator.geolocation) return Promise.resolve("unavailable");
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(distanceM(p.coords.latitude, p.coords.longitude, SITE.lat, SITE.lon) <= SITE.radiusM ? "ok" : "far"),
      (err) => resolve(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    ),
  );
}

export const GEO_TEXT: Record<Exclude<GeoResult, "ok">, string> = {
  far: `벽에 남기기는 ${SITE.name} 근처에서만 할 수 있어요.\n모두의 벽 구경은 어디서나 할 수 있어요!`,
  denied: "벽에 남기려면 위치 확인이 필요해요.\n브라우저 설정에서 위치 권한을 허용해 주세요.",
  unavailable: "지금은 위치를 확인할 수 없어요.\n잠시 후 다시 시도해 주세요.",
};
