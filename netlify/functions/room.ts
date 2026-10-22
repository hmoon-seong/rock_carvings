// Netlify Function (v2, web-standard): POST /api/room. Logic in server/room.ts.

import { handleRoom } from "../../server/room.ts";

export default (req: Request, context: { ip?: string }) => handleRoom(req, process.env, context?.ip);

export const config = { path: "/api/room" };
