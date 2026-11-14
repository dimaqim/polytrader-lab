import { WeatherEngine } from "../server/weather/engine.ts";

const probe = process.argv.includes("--probe");
if (!probe && !process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const engine = new WeatherEngine(!probe, ".collector/weather-books");
process.once("SIGTERM", () => engine.stop());
process.once("SIGINT", () => engine.stop());
await engine.run(probe ? Date.now() + 15 * 60_000 : Infinity);
