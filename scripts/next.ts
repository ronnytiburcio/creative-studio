/**
 * `npm run dev` / `npm run start`: validate config (fail fast), copy the env file's tool paths into the environment
 * (config.ts applyToolEnv), then run Next bound to 127.0.0.1 on STUDIO_PORT. Never listens on other interfaces.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { applyToolEnv, ensureAppDirs, ensureEnvFile, getConfig } from "../src/lib/config";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("usage: tsx scripts/next.ts dev|start");
  process.exit(2);
}

const created = ensureEnvFile();
let cfg;
try {
  cfg = getConfig();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
ensureAppDirs(cfg);
// The env file's tool paths (ffmpeg, the engine CLIs) reach the Next server through its environment (process env wins).
applyToolEnv(cfg);
if (created) console.log(`config: created template ${cfg.envFile}`);

const bin = path.join(process.cwd(), "node_modules", ".bin", "next");
const child = spawn(bin, [mode, "-H", cfg.host, "-p", String(cfg.port)], {
  stdio: "inherit",
  env: {
    ...process.env,
    STUDIO_DB: cfg.dbPath,
    STUDIO_CACHE: cfg.cacheDir,
    STUDIO_LOGS: cfg.logsDir,
    STUDIO_PORT: String(cfg.port),
    STUDIO_DRIVE: cfg.drivePath,
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
console.log(`${cfg.appName} (${mode}) on http://${cfg.host}:${cfg.port}${cfg.fakeUnmounted ? "  [STUDIO_FAKE_UNMOUNTED]" : ""}`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
