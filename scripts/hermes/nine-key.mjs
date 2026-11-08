// Mint (or recover) the one long-lived 9router API key that Hermes uses.
//
// The key lives inside the 9router database, and that database is restored from
// the encrypted release asset on every run, so the value stays the same across
// runners. This script only creates a key on the very first cold start (or when
// the archived database was missing), which is why it reports whether it minted
// a new one: the loop then refreshes the 9router snapshot so the next runner
// restores the key that Hermes is actually using.
//
// The key itself is never logged. It is written to the file given on the
// command line (mode 0600) and read from there by boot.sh.
import { appendFile, writeFile } from "node:fs/promises";

const BASE = `http://127.0.0.1:${process.env.ROUTER_PORT || 20128}`;
const PASSWORD = process.env.NINE_ROUTER_PASSWORD || "";
const KEY_NAME = (process.env.NINE_KEY_NAME || "hermes").trim();
const OUT = process.argv[2] || process.env.NINE_KEY_FILE || "";

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(`nine-key: ${message}`);
  process.exit(1);
}

async function call(path, { method = "GET", body, cookie, token } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, ok: res.ok, text, json, cookie: cookies.map((c) => c.split(";")[0]).join("; ") };
}

async function login() {
  const res = await call("/api/auth/login", { method: "POST", body: { password: PASSWORD } });
  if (!res.ok) fail(`login failed: HTTP ${res.status} ${res.text.slice(0, 160)}`);
  const token =
    (res.json && (res.json.token || res.json.accessToken || res.json.access_token)) || "";
  return { cookie: res.cookie || "", token: typeof token === "string" ? token : "" };
}

function keyFrom(json) {
  // POST /api/keys answers {key: "<value>"} or {key: {key: "<value>"}}.
  if (!json) return "";
  if (typeof json.key === "string") return json.key;
  if (json.key && typeof json.key.key === "string") return json.key.key;
  if (typeof json.token === "string") return json.token;
  return "";
}

async function main() {
  if (!PASSWORD) fail("NINE_ROUTER_PASSWORD is not set");
  if (!OUT) fail("no output file was given");

  // 9router was started a moment ago by router.mjs; give the API a chance to
  // answer before treating a connection error as fatal.
  let auth = null;
  for (let i = 1; i <= 30; i++) {
    try {
      auth = await login();
      break;
    } catch (e) {
      if (i === 30) fail(`9router did not answer on ${BASE}: ${e.message}`);
      await sleep(2000);
    }
  }
  if (!auth) fail("could not log in to 9router");
  const { cookie, token } = auth;
  if (!cookie && !token) fail("login returned neither a cookie nor a token");

  const list = async () =>
    call("/api/keys", { cookie, token }).then((r) => {
      if (!r.ok) throw new Error(`GET /api/keys -> HTTP ${r.status} ${r.text.slice(0, 120)}`);
      return (r.json && (r.json.keys || r.json.data || [])) || [];
    });

  let key = "";
  let minted = false;
  let id = "";
  try {
    const keys = await list();
    const usable = keys.filter((k) => k && typeof k.key === "string" && k.key && !/^zen-diag-/.test(k.name || ""));
    const found = usable.find((k) => k.name === KEY_NAME) || usable.find((k) => k.name === "hermes");
    if (found) {
      key = typeof found.key === "string" ? found.key : "";
      id = found.id || "";
      if (key) log(`• 9router key reused: "${found.name || KEY_NAME}"`);
    }
  } catch (e) {
    log(`• could not list existing keys (${e.message}); minting one`);
  }

  if (!key) {
    const created = await call("/api/keys", { method: "POST", body: { name: KEY_NAME }, cookie, token });
    if (!created.ok) fail(`POST /api/keys -> HTTP ${created.status} ${created.text.slice(0, 160)}`);
    key = keyFrom(created.json);
    if (!key) fail(`POST /api/keys returned no key: ${created.text.slice(0, 160)}`);
    minted = true;
    log(`• 9router key created: "${KEY_NAME}"`);
  }

  // Prove the key before handing it to Hermes: an unusable key would show up
  // much later as an opaque 401 from the agent.
  const probe = await call("/v1/models", { token: key });
  if (!probe.ok) {
    fail(`the key is not accepted by /v1/models (HTTP ${probe.status} ${probe.text.slice(0, 160)})`);
  }
  const models = ((probe.json && probe.json.data) || []).map((m) => m.id).filter(Boolean);
  const wanted = process.env.HERMES_MODEL || "oc/deepseek-v4.1-flash-free";
  log(`• /v1/models answered ${probe.status}${models.length ? ` (${models.length} models)` : ""}`);
  if (models.length && !models.includes(wanted)) {
    log(`  warning: ${wanted} is not in the list: ${models.slice(0, 12).join(", ")}`);
  }

  await writeFile(OUT, `${key}\n`, { mode: 0o600 });
  log(`• key written to ${OUT} (value hidden, ${key.length} chars)`);

  if (minted && process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, "NINE_KEY_MINTED=1\n");
  }
  if (id) log(`• key id ${id}`);
}

main().catch((e) => {
  console.error(`nine-key: ${e.message}`);
  process.exit(1);
});
