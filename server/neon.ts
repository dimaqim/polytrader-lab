import { log } from "./db.ts";
import { webhook } from "./telegram.ts";
import { runWorker } from "./worker.ts";

export default {
  async fetch(req: Request) {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/health") return Response.json({ ok: true, service: "polytrader" });
    if (req.method !== "POST") return new Response(null, { status: 405 });
    if (pathname === "/telegram") return webhook(req);
    if (pathname !== "/monitor" && pathname !== "/daily") return new Response(null, { status: 404 });
    const invocation = req.headers.get("x-neon-trigger-invocation-id");
    if (!invocation) return new Response(null, { status: 403 });
    const body = await req.json();
    const slot = Date.parse(body?.data?.scheduled_at);
    if (body?.invocation_id && body.invocation_id !== invocation) return new Response(null, { status: 403 });
    if (!Number.isFinite(slot) || slot % 60_000 !== 0 || slot > Date.now() + 5_000 || slot < Date.now() - 3_600_000) {
      return Response.json({ error: "invalid_schedule_slot" }, { status: 400 });
    }
    try { await runWorker(slot, pathname === "/daily"); }
    catch (error) { await log("neon_schedule", error); return Response.json({ error: "job_failed" }, { status: 503 }); }
    return Response.json({ ok: true });
  },
};
