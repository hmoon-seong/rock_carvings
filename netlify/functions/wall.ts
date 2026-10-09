// Netlify Function (v2, web-standard): GET/POST /api/wall. Logic in server/wall.ts.

import { handleWall } from "../../server/wall.ts";

export default (req: Request, context: { ip?: string }) => handleWall(req, process.env, context?.ip);

export const config = { path: "/api/wall" };
