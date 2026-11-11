import { neon } from "@neondatabase/serverless";

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("database_unconfigured");
  return neon(url);
}
export function date(time: number) {
  return new Date(time).toISOString();
}
export async function log(area: string, error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/https?:\/\/\S+|postgres(?:ql)?:\/\/\S+|\d{6,}:[\w-]{20,}/g, "[redacted]").slice(0, 360);
  try {
    await database()`insert into lab.logs(area,level,message) values(${area},'error',${message})`;
  } catch {
    console.error(area, message);
  }
}
