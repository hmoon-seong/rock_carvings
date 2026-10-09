// Small helpers shared by the serverless handlers (web-standard Request/Response).

export type Env = Record<string, string | undefined>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Reads a JSON body up to `maxBytes`; null if too big or not JSON. */
export async function readJson<T>(req: Request, maxBytes: number): Promise<T | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Client key for rate limiting: the platform's client IP, else the first forwarded address. */
export function clientKey(req: Request, ip?: string): string {
  return ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "anon";
}

/** A base64 PNG, with or without the data: prefix; null if it is not one or too big. */
export function pngBase64(image: unknown, maxBytes = 400_000): string | null {
  if (typeof image !== "string") return null;
  const b64 = image.replace(/^data:image\/png;base64,/, "");
  if (b64.length > maxBytes || !/^iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(b64)) return null;
  return b64;
}
