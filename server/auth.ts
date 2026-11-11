import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { database } from "./db.ts";

export function equal(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function telegramIdentity(initData: string, token: string, now = Date.now()) {
  if (initData.length > 8192 || !token) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (new Set(params.keys()).size !== [...params.keys()].length || !hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
  params.delete("hash");
  params.sort();
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  const check = [...params].map(([k, v]) => `${k}=${v}`).join("\n");
  if (!equal(hash, createHmac("sha256", key).update(check).digest("hex"))) return null;
  const age = now / 1000 - Number(params.get("auth_date"));
  if (!Number.isFinite(age) || age < -30 || age > 900) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null");
    if (!Number.isSafeInteger(user?.id) || user.id <= 0 || typeof user.first_name !== "string") return null;
    return { id: String(user.id), name: user.first_name.slice(0, 100) };
  } catch { return null; }
}

const sessionName = "polytrader_session";
export function sessionCookie(id: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("session_unconfigured");
  const lifetime = 7 * 24 * 3600;
  const payload = `${id}.${Math.floor(Date.now() / 1000) + lifetime}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `${sessionName}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetime}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export function sessionUser(req: Request) {
  const secret = process.env.SESSION_SECRET;
  const cookie = req.headers.get("cookie")?.split(";").map(c => c.trim()).find(c => c.startsWith(sessionName + "="));
  const match = cookie?.slice(sessionName.length + 1).match(/^(\d+)\.(\d+)\.([a-f0-9]{64})$/);
  if (!match || !secret || Number(match[2]) <= Date.now() / 1000) return null;
  const expected = createHmac("sha256", secret).update(`${match[1]}.${match[2]}`).digest("hex");
  return equal(match[3], expected) ? match[1] : null;
}
export const pairingHash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function createPairing() {
  const code = randomBytes(24).toString("base64url");
  const secret = randomBytes(24).toString("base64url");
  await database()`insert into lab.pairings(code_hash,proof_hash,expires_at) values(${pairingHash(code)},${pairingHash(secret)},now()+interval '10 minutes')`;
  return { code, secret };
}
