import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

await mkdir("dist/neon", { recursive: true });
await build({
  entryPoints: ["server/neon.ts"], bundle: true, platform: "node", target: "node24",
  format: "esm", outfile: "dist/neon/index.mjs",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
await rm("dist/polytrader-neon.zip", { force: true });
execFileSync("zip", ["-j", "-q", "dist/polytrader-neon.zip", "dist/neon/index.mjs"]);
