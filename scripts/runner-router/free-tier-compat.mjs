// Compatibility front for 9router's OpenCode free-tier traffic.
//
// Why this exists: 9router does not always reach its free provider through the
// optional `wreq-js` transport it declares. Measured on a live runner, a request
// for `oc/deepseek-v4.1-flash-free` went straight from Node to the legacy
// `https://opencode.ai/inference/v1/chat/completions` base and was answered with
// `429 FreeUsageLimitError`, while the shim stayed idle (zen-proxy logged no
// request at all). So interception has to happen at the destination, not at the
// dependency: the app's `oc` base URL is pointed at this listener instead.
//
// This proxy accepts whatever path the app builds (`/inference/v1/chat/...`,
// `/v1/...`, `/messages`, `/responses`), strips the identity headers the gateway
// refuses, and forwards to zen-proxy on Bun (the stack the free tier accepts),
// streaming the answer back unchanged.

import http from "node:http";

const listen = (process.env.FREE_TIER_LISTEN || "127.0.0.1:8787").trim();
const port = Number(listen.split(":").pop());
const host = listen.slice(0, listen.length - String(port).length - 1) || "127.0.0.1";
const upstream = (process.env.FREE_TIER_UPSTREAM || "http://127.0.0.1:8788").replace(/\/+$/, "");

// zen-proxy owns the wire identity; forwarding the app's own values would defeat
// it (9router's session ids do not even match the CLI's format).
const DROP = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-opencode-project",
  "x-opencode-client",
  "x-session-affinity",
  "x-session-id",
  "user-agent",
]);

const HOP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

// The free lane answers the way the OpenCode client asks: OpenCode computes an
// output budget and sends it. Hermes deliberately omits max_tokens (see
// NousResearch/hermes-agent#4404), so a reasoning model can spend the server's
// small default entirely on thinking and return an empty message — the
// "thinking-only / empty response / No reply" loop seen in Telegram. OpenCode
// itself never hits that because it always sends its own budget.
// So: give every request the free lane's official output ceiling (32k) when the
// caller asked for nothing, and never override a caller that did ask.
const DEFAULT_OUTPUT_TOKENS = Number(process.env.FREE_TIER_MAX_OUTPUT || 32000);

function withBudget(raw, pathname) {
  if (!raw.length) return { body: raw, budget: "none" };
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return { body: raw, budget: "unparsed" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { body: raw, budget: "unparsed" };
  }
  const asked = payload.max_output_tokens ?? payload.max_completion_tokens ?? payload.max_tokens;
  if (asked != null) return { body: raw, budget: `caller(${asked})` };
  if (!Number.isFinite(DEFAULT_OUTPUT_TOKENS) || DEFAULT_OUTPUT_TOKENS <= 0) {
    return { body: raw, budget: "none" };
  }
  // The field name follows the protocol, not the request: Anthropic /messages
  // and chat both use max_tokens, the Responses API uses max_output_tokens.
  const key = /\/responses\/?$/.test(pathname) ? "max_output_tokens" : "max_tokens";
  payload[key] = DEFAULT_OUTPUT_TOKENS;
  return { body: Buffer.from(JSON.stringify(payload)), budget: `injected(${DEFAULT_OUTPUT_TOKENS})` };
}

function route(pathname) {
  const path = pathname.split("?")[0];
  if (/\/messages\/?$/.test(path)) return "/v1/messages";
  if (/\/responses\/?$/.test(path)) return "/v1/responses";
  if (path === "/health" || path === "/healthz") return "/health";
  if (path.startsWith("/v1/")) return path;
  return "/v1/chat/completions";
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch {
    /* client went away */
  }
  const body = Buffer.concat(chunks);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP.has(k.toLowerCase())) headers[k] = v;
  }
  if (!headers.authorization) headers.authorization = "Bearer public";
  if (!headers["content-type"] && body.length) headers["content-type"] = "application/json";

  const target = `${upstream}${route(req.url || "/")}`;
  // Only JSON bodies carry a token budget; leave form bodies and GETs alone.
  const type = String(req.headers["content-type"] || "").toLowerCase();
  const jsonish = type.includes("json") || (!type && body.length > 0);
  const { body: sendBody, budget } =
    req.method === "POST" && jsonish ? withBudget(body, route(req.url || "/")) : { body, budget: "none" };
  const started = Date.now();
  try {
    const up = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : sendBody,
    });
    const out = {};
    up.headers.forEach((v, k) => {
      if (!HOP.has(k.toLowerCase())) out[k] = v;
    });
    res.writeHead(up.status, out);
    if (up.body) {
      for await (const chunk of up.body) res.write(chunk);
    }
    res.end();
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.url} -> ${target} ${up.status} ${Date.now() - started}ms budget=${budget}`,
    );
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `free-tier compat: ${err.message}` } }));
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${target} FAILED ${err.message}`);
  }
});

server.listen(port, host, () => console.log(`free-tier compat listening on http://${host}:${port} -> ${upstream}`));
