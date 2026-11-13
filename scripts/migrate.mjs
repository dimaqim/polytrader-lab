import { neon } from "@neondatabase/serverless";
import { readdir, readFile } from "node:fs/promises";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const sql = neon(url);
const directory = new URL("../db/", import.meta.url);
const files = (await readdir(directory)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
for (const filename of files) {
  const source = await readFile(new URL(filename, directory), "utf8");
  const statements = source.split(/\n(?=create |insert |alter |update )/).map(text => text.trim()).filter(Boolean);
  await sql.transaction(statements.map(statement => sql.query(statement, [])));
  console.log("Applied " + filename);
}
