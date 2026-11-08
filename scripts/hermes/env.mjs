// Sync the values that must always come from repository secrets into
// ~/.hermes/.env, without touching anything else the restored home already has
// (home channel, proxy settings, extra keys the agent saved itself).
//
// Only names listed in REQUIRED are written, and only when the matching
// environment variable is set. That keeps `hermes import` as the source of
// truth for everything that is not a secret.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const REQUIRED = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USERS",
  "NINE_ROUTER_API_KEY",
];
const OPTIONAL = ["TELEGRAM_HOME_CHANNEL", "TELEGRAM_HOME_CHANNEL_NAME", "HERMES_TIMEZONE"];

const home = process.env.HERMES_HOME || join(homedir(), ".hermes");
const file = join(home, ".env");

const wanted = new Map();
for (const name of [...REQUIRED, ...OPTIONAL]) {
  const value = (process.env[name] || "").trim();
  if (value) wanted.set(name, value);
}

await mkdir(home, { recursive: true, mode: 0o700 });

let existing = "";
try {
  existing = await readFile(file, "utf8");
} catch {
  /* first run */
}

const lines = existing ? existing.split(/\r?\n/) : [];
const seen = new Set();
const out = [];

for (const line of lines) {
  const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
  if (!m || !wanted.has(m[1])) {
    out.push(line);
    continue;
  }
  const name = m[1];
  if (seen.has(name)) continue; // drop duplicates, keep the first position
  seen.add(name);
  out.push(`${name}=${wanted.get(name)}`);
}

for (const [name, value] of wanted) {
  if (!seen.has(name)) out.push(`${name}=${value}`);
}

while (out.length && out[out.length - 1] === "") out.pop();
await writeFile(file, `${out.join("\n")}\n`, { mode: 0o600 });
await chmod(file, 0o600);

const missing = REQUIRED.filter((name) => !wanted.has(name));
console.log(`• .env synced: ${[...wanted.keys()].join(", ") || "nothing"}`);
if (missing.length) {
  console.error(`::error::missing required secret(s): ${missing.join(", ")}`);
  process.exit(1);
}
