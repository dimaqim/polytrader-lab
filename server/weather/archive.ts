import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, unlink, open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { database } from "../db.ts";
import { state } from "./ledger.ts";

type ArchiveRow = { id:string; version:string; json:string };
const retention = {
  "weather.inputs":"72 hours",
  "weather.audit":"14 days",
  "lab.wallet_activity":"24 hours",
  "lab.logs":"14 days",
} as const;
type Table = keyof typeof retention;
const batchSize = 1500;

async function rows(table:Table) {
  const sql=database();
  const condition = table==="weather.audit" ? "and (r.action='SKIP' or (r.action='HOLD' and r.reason='SETTLEMENT_HOLD'))" : "";
  const key = table==="weather.inputs" ? "r.kind || ':' || r.id" : table==="lab.wallet_activity" ? "r.wallet || ':' || r.id" : "r.id::text";
  const time = table==="weather.inputs" ? "r.received_at" : table==="lab.wallet_activity" ? "r.event_at" : "r.at";
  return await sql.query(`select ${key} as id, md5(to_jsonb(r)::text) as version, to_jsonb(r)::text as json
    from ${table} r where ${time}<now()-$1::interval ${condition} order by ${time},r.id limit ${batchSize}`, [retention[table]]) as ArchiveRow[];
}

async function remove(table:Table, entries:ArchiveRow[]) {
  const key = table==="weather.inputs" ? "r.kind || ':' || r.id" : table==="lab.wallet_activity" ? "r.wallet || ':' || r.id" : "r.id::text";
  return database().query(`with removed as (
    delete from ${table} r using jsonb_to_recordset($1::jsonb) as saved(id text,version text)
    where ${key}=saved.id and md5(to_jsonb(r)::text)=saved.version returning 1
  ) select count(*)::int count from removed`, [JSON.stringify(entries.map(({id,version})=>({id,version})))]);
}

export async function maintainArchive(directory:string) {
  const [schema]=await database()`select to_regclass('lab.storage_samples') is not null enabled`;
  if(!schema.enabled)return 0;
  await mkdir(directory,{recursive:true,mode:0o700});
  const summary: Record<string,number> = {};
  for (const table of Object.keys(retention) as Table[]) {
    const entries = await rows(table);
    summary[table]=0;
    if (!entries.length) continue;
    const payload=entries.map(row=>row.json+"\n");
    const digest=createHash("sha256");
    for(const line of payload)digest.update(line);
    const checksum=digest.digest("hex");
    const path=`${directory}/${table}-${checksum}.ndjson.gz`;
    const temp=path+`.${process.pid}.part`;
    try {
      await pipeline(Readable.from(payload),createGzip({level:5}),createWriteStream(temp,{mode:0o600,flags:"wx"}));
      const verification=createHash("sha256");
      let lines=0;
      for await(const line of createInterface({input:createReadStream(temp).pipe(createGunzip()),crlfDelay:Infinity})) {
        JSON.parse(line);
        verification.update(line+"\n");
        lines++;
      }
      if (lines!==entries.length || verification.digest("hex")!==checksum) throw Error("Archive verification failed: "+table);
      const file=await open(temp,"r");
      try { await file.sync(); } finally { await file.close(); }
      await rename(temp,path);
      const parent=await open(directory,"r");
      try { await parent.sync(); } finally { await parent.close(); }
      const [result]=await remove(table,entries);
      summary[table]=result.count;
    } finally {
      await unlink(temp).catch(error=>{if(error.code!=="ENOENT")throw error;});
    }
  }
  await state("archive",{verified:true,rows:summary});
  return Object.values(summary).reduce((sum,count)=>sum+count,0);
}
