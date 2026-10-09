// Netlify Function (v2, web-standard): POST /api/score. Logic in server/score.ts.

import { handleScore } from "../../server/score.ts";

export default (req: Request, context: { ip?: string }) => handleScore(req, process.env, context?.ip);

export const config = { path: "/api/score" };
