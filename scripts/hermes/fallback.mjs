// Keep a 9router combo in front of Hermes's model so a free-tier hiccup falls
// over to the next free model instead of ending in "No reply".
//
// Why a combo instead of one model: 9router's combo path peeks a streaming
// answer and, when the model produced no client content at all (reasoning-only
// counts as empty), retries the request on the next seat. It also falls over on
// 429/502/503/504. Both are exactly the failures this loop kept hitting.
//
// The combo lives in the 9router database, which the relay backs up and
// restores, so it survives the handoff; this script only keeps it in sync with
// the desired model list.
//
// Never fatal: if anything here fails the session still runs on the primary
// model, because HERMES_MODEL_OVERRIDE is only written on success.
import { appendFile, readFile } from "node:fs/promises";

const PORT = (process.env.ROUTER_PORT || "20128").trim();
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = (process.env.NINE_ROUTER_PASSWORD || "").trim();
const KEY_FILE = (process.env.NINE_KEY_FILE || "").trim();
const COMBO = (process.env.FALLBACK_COMBO || "hermes-free").trim();
const PRIMARY = (process.env.HERMES_PRIMARY_MODEL || "oc/deepseek-v4.1-flash-free").trim();
const FALLBACKS = (process.env.HERMES_FALLBACK_MODELS || "oc/mimo-v2.5-free,oc/glm-5.3-flash-free")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const log = (...a) => console.log(...a);
const warn = (m) => console.log(`::warning::${m}`);

function fail(message) {
  warn(`fallback: ${message}`);
  process.exit(0); // degrade to the primary model, never kill the runner
}

let cookie = "";
async function api(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  return res;
}

async function login() {
  if (!PASSWORD) fail("NINE_ROUTER_PASSWORD is not set");
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (res.status !== 200) fail(`login answered HTTP ${res.status}`);
  cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) fail("login set no session cookie");
}

async function availableModels() {
  let key = "";
  try {
    key = (await readFile(KEY_FILE, "utf8")).trim();
  } catch {
    fail(`cannot read ${KEY_FILE}`);
  }
  const res = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) fail(`/v1/models answered HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  const ids = (body.data || body.models || []).map((m) => m?.id).filter(Boolean);
  return new Set(ids);
}

async function main() {
  await login();
  const available = await availableModels();

  // Keep the primary even if the catalogue omits it: without it there is
  // nothing to fall back from.
  const seats = [PRIMARY];
  for (const id of FALLBACKS) {
    if (available.has(id)) seats.push(id);
    else warn(`fallback model ${id} is not offered right now — skipped`);
  }
  log(`• combo ${COMBO}: ${seats.join(" -> ")}`);

  const list = await api("/api/combos");
  if (!list.ok) fail(`GET /api/combos answered HTTP ${list.status}`);
  const combos = (await list.json().catch(() => ({}))).combos || [];
  const existing = combos.find((c) => c?.name === COMBO);

  if (!existing) {
    const res = await api("/api/combos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: COMBO, models: seats }),
    });
    if (!res.ok) fail(`POST /api/combos answered HTTP ${res.status} ${await res.text()}`);
    log(`• created combo ${COMBO}`);
  } else if (JSON.stringify(existing.models) !== JSON.stringify(seats)) {
    const res = await api(`/api/combos/${existing.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: COMBO, models: seats }),
    });
    if (!res.ok) fail(`PUT /api/combos/${existing.id} answered HTTP ${res.status} ${await res.text()}`);
    log(`• updated combo ${COMBO}`);
  } else {
    log(`• combo ${COMBO} is already in sync`);
  }

  // Only now does Hermes switch its model: a failed combo must not leave the
  // gateway pointing at a name 9router does not know.
  if (process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, `HERMES_MODEL_OVERRIDE=${COMBO}\n`);
    log(`• Hermes will use ${COMBO}`);
  }
}

try {
  await main();
} catch (e) {
  fail(e?.message || String(e));
}
