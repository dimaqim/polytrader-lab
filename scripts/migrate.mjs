import { neon } from "@neondatabase/serverless";
import { readdir, readFile } from "node:fs/promises";

const url = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "postgresql://unset");
if (url.hostname==="unset") throw new Error("DATABASE_URL required");
url.hostname=url.hostname.replace(/-pooler\./,".");
const sql = neon(url.href);
const directory = new URL("../db/", import.meta.url);
const requested=process.argv[2];
const files = (await readdir(directory)).filter(name => /^\d+_.*\.sql$/.test(name) && (!requested || name===requested)).sort();
if (!files.length) throw new Error("Migration not found");
for (const filename of files) {
  const source = await readFile(new URL(filename, directory), "utf8");
  const statements = source.split(/\n(?=create |insert |alter |update )/).map(text => text.trim()).filter(Boolean);
  await sql.transaction(statements.map(statement => sql.query(statement, [])));
  console.log("Applied " + filename);
}
