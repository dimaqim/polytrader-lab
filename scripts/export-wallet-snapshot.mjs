import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";

const source = process.env.ARCHIVE_SOURCE_URL;
if (!source || !process.argv[2]) throw Error("Provide the isolated snapshot URL and destination");
const directory = process.argv[2];
await mkdir(directory, { recursive:true, mode:0o700 });
const path = directory + "/wallet-history-2026-11-14.ndjson.gz";
const sql = neon(source);
const [snapshot] = await sql`select count(*)::int total from lab.wallet_activity`;
if (!snapshot.total) throw Error("Snapshot has no wallet activity");
let written = 0;
const digest = createHash("sha256");
async function* rows() {
  let wallet = "", id = "";
  while (true) {
    const page = await sql`select wallet,id,event_at,detected_at,payload from lab.wallet_activity
      where (wallet,id)>(${wallet},${id}) order by wallet,id limit 2000`;
    if (!page.length) break;
    for (const row of page) {
      const line = JSON.stringify(row)+"\n";
      digest.update(line);
      written++;
      yield line;
    }
    ({ wallet,id }=page.at(-1));
    if(written%40_000===0)console.log(`Wallet history exported: ${written}/${snapshot.total}`);
  }
}
await pipeline(Readable.from(rows()),createGzip({level:5}),createWriteStream(path+".part",{mode:0o600,flags:"wx"}));
const verified = createHash("sha256");
let count=0;
for await (const line of createInterface({input:createReadStream(path+".part").pipe(createGunzip()),crlfDelay:Infinity})) {
  JSON.parse(line);
  verified.update(line+"\n");
  count++;
}
const sha256 = digest.digest("hex");
if (count!==snapshot.total || count!==written || verified.digest("hex")!==sha256) throw Error("Snapshot export verification failed");
await rename(path+".part",path);
await writeFile(path+".json",JSON.stringify({ count,sha256, snapshot:"snap-muddy-union-bao6d84m",sha256Of:"uncompressed NDJSON" },null,2)+"\n",{mode:0o600});
console.log(JSON.stringify({count,sha256}));
