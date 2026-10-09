// Vite config. The /api/* serverless handlers also run inside `npm run dev` and `npm run preview`,
// so the whole app (scoring proxy + shared wall) works locally without the Netlify CLI.
// Server env vars (DASHSCOPE_API_KEY, SUPABASE_*) come from .env.local / the shell and never
// reach the client bundle (Vite only exposes VITE_* variables to client code).

import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import { handleScore } from "./server/score.ts";
import { handleWall } from "./server/wall.ts";
import type { Env } from "./server/http.ts";

const ROUTES: Record<string, (req: Request, env: Env, ip?: string) => Promise<Response>> = {
  "/api/score": handleScore,
  "/api/wall": handleWall,
};

function apiMiddleware(env: Env): Connect.NextHandleFunction {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handler = ROUTES[url.pathname];
    if (!handler) return next();
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => (v == null ? [] : [[k, String(v)]])) as [string, string][],
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const response = await handler(request, env, req.socket.remoteAddress);
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      res.statusCode = 500;
      res.end("{}");
    }
  };
}

function api(env: Env): Plugin {
  return {
    name: "amgakhwamon-api",
    configureServer: (server) => void server.middlewares.use(apiMiddleware(env)),
    configurePreviewServer: (server) => void server.middlewares.use(apiMiddleware(env)),
  };
}

export default defineConfig(({ mode }) => {
  const env: Env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };
  // MOCK=1 forces mock mode even when keys are set (e.g. to demo without spending API calls).
  if (env.MOCK === "1") delete env.DASHSCOPE_API_KEY, delete env.SUPABASE_URL;
  return { plugins: [api(env)] };
});
