import { timingSafeEqual } from "node:crypto";
import { upgradeWebSocket } from "@neon/functions";
import { marketSocket } from "../polymarket.ts";

const assetId = /^\d{1,80}$/;
const maxAssets = 480;
let occupied = false;

export default {
  fetch(request: Request) {
    const expected = Buffer.from(process.env.WEATHER_RELAY_SECRET ?? "");
    const supplied = Buffer.from(request.headers.get("x-weather-relay-secret") ?? "");
    if (new URL(request.url).pathname !== "/stream") return new Response(null, { status: 404 });
    if (expected.length < 32 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return new Response(null, { status: 401 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    if (occupied) return new Response(null, { status: 429 });

    const { socket, response } = upgradeWebSocket(request);
    occupied = true;
    const upstream = new WebSocket(marketSocket);
    const pending: string[] = [];
    const assets = new Set<string>();
    let initialized = false;
    let stopped = false;
    let lastPing = 0;
    let lastMessage = Date.now();
    let messageCount = 0;
    let windowStart = lastMessage;
    const stop = (code = 1011, reason = "Polymarket stream unavailable") => {
      if (stopped) return;
      stopped = true;
      occupied = false;
      clearTimeout(connectTimeout);
      clearInterval(watch);
      if (socket.readyState < WebSocket.CLOSING) socket.close(code, reason);
      if (upstream.readyState < WebSocket.CLOSING) upstream.close();
    };
    const connectTimeout = setTimeout(() => stop(), 8000);
    const watch = setInterval(() => {
      if (Date.now() - lastMessage > 25_000) stop(1001, "Client disconnected");
    }, 5000);
    upstream.addEventListener("open", () => {
      clearTimeout(connectTimeout);
      for (const frame of pending) upstream.send(frame);
      pending.length = 0;
    });
    upstream.addEventListener("message", event => {
      if (socket.readyState !== WebSocket.OPEN || typeof event.data !== "string" || socket.bufferedAmount > 2_000_000) {
        stop();
        return;
      }
      socket.send(event.data);
    });
    upstream.addEventListener("error", () => stop());
    upstream.addEventListener("close", () => stop());
    socket.addEventListener("close", () => stop(1000, "Client closed"));
    socket.addEventListener("error", () => stop());
    socket.addEventListener("message", event => {
      const now = Date.now();
      lastMessage = now;
      if (now - windowStart >= 1000) { windowStart = now; messageCount = 0; }
      if (typeof event.data !== "string" || event.data.length > 4500 || ++messageCount > 16) {
        stop(1008, "Invalid request");
        return;
      }
      const send = (frame: string) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else if (pending.length < 32) pending.push(frame);
        else stop();
      };
      if (event.data === "PING") {
        if (now - lastPing >= 2000) { lastPing = now; send("PING"); }
        return;
      }
      let frame;
      try { frame = JSON.parse(event.data); }
      catch { stop(1008, "Invalid JSON"); return; }
      if (!frame || !Array.isArray(frame.assets_ids) || !frame.assets_ids.length || frame.assets_ids.length > maxAssets
        || frame.assets_ids.some((id: unknown) => typeof id !== "string" || !assetId.test(id))) {
        stop(1008, "Invalid asset IDs");
        return;
      }
      const ids = [...new Set<string>(frame.assets_ids)];
      if (!initialized && frame.type === "market") {
        initialized = true;
        for (const id of ids) assets.add(id);
        send(JSON.stringify({type:"market",assets_ids:ids,custom_feature_enabled:true}));
      } else if (initialized && frame.operation === "subscribe") {
        for (const id of ids) assets.add(id);
        if (assets.size > maxAssets) { stop(1008, "Too many assets"); return; }
        send(JSON.stringify({operation:"subscribe",assets_ids:ids,custom_feature_enabled:true}));
      } else if (initialized && frame.operation === "unsubscribe") {
        for (const id of ids) assets.delete(id);
        send(JSON.stringify({operation:"unsubscribe",assets_ids:ids}));
      } else stop(1008, "Invalid subscription");
    });
    return response;
  },
};
