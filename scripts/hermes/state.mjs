// Encrypted off-runner backup of the Hermes home, stored as GitHub release
// assets in the same repository as the workflow.
//
//   node scripts/hermes/state.mjs restore   # newest snapshot -> hermes import
//   node scripts/hermes/state.mjs backup    # hermes backup -> newest snapshot
//
// Two slots, like router.mjs: `hermes-state.zip.enc` (newest) and
// `hermes-state.prev.zip.enc` (the one it replaced). A snapshot is only
// promoted after it was written completely, so a crash mid-upload can never
// destroy the last good state.
//
// The archive holds tokens (Telegram bot token, the 9router key), so it is
// AES-256-GCM sealed with BACKUP_ENCRYPTION_KEY before it leaves the runner.
// The GitHub release is public; the ciphertext is not useful without the key.
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = (process.env.BACKUP_REPO || process.env.GITHUB_REPOSITORY || "").trim();
const TOKEN = (process.env.GH_PAT || process.env.GITHUB_TOKEN || "").trim();
const PASSPHRASE = (process.env.BACKUP_ENCRYPTION_KEY || "").trim();
const TAG = (process.env.HERMES_BACKUP_TAG || "hermes-state").trim();
const ASSET = (process.env.HERMES_BACKUP_ASSET || "hermes-state.zip.enc").trim();
const PREV = (process.env.HERMES_BACKUP_PREV || "hermes-state.prev.zip.enc").trim();
const HERMES = process.env.HERMES_BIN || "hermes";

// A different salt than router.mjs on purpose: the two archives must never
// share a key stream even though they share the passphrase.
const SALT = "hermes-loop-state-v1";
const MAGIC = "HLS1";
const MIN_BYTES = 4096;

const log = (...a) => console.log(...a);

function fail(message) {
  console.error(`state: ${message}`);
  process.exit(1);
}

function key() {
  if (!PASSPHRASE) fail("BACKUP_ENCRYPTION_KEY is not set");
  return scryptSync(PASSPHRASE, SALT, 32);
}

function seal(bytes) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(bytes), c.final()]);
  return Buffer.concat([Buffer.from(MAGIC, "latin1"), iv, c.getAuthTag(), body]);
}

function unseal(bytes) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 4).toString("latin1") !== MAGIC) {
    throw new Error("the archive does not start with the Hermes-loop magic");
  }
  const iv = b.subarray(4, 16);
  const tag = b.subarray(16, 32);
  const body = b.subarray(32);
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

const headers = (extra = {}) => ({
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "hermes-loop-state",
  ...extra,
});

async function findRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, {
    headers: headers(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`cannot read release: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function ensureRelease() {
  const found = await findRelease();
  if (found) return found;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      tag_name: TAG,
      name: "Hermes home backup",
      body: "Encrypted Hermes state written by the hermes-loop workflow. Do not delete manually.",
      draft: false,
      prerelease: false,
    }),
  });
  if (!res.ok) throw new Error(`cannot create release: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function uploadAsset(name, bytes) {
  const release = await ensureRelease();
  for (const a of (release.assets || []).filter((x) => x.name === name)) {
    await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${a.id}`, {
      method: "DELETE",
      headers: headers(),
    });
  }
  const res = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: headers({ "Content-Type": "application/octet-stream" }),
      body: bytes,
    },
  );
  if (!res.ok) throw new Error(`cannot upload ${name}: HTTP ${res.status} ${await res.text()}`);
  log(`• upload: ${name} (${(bytes.length / 1024).toFixed(1)} KiB)`);
}

async function downloadAsset(name) {
  const release = await findRelease();
  if (!release) return null;
  const asset = (release.assets || []).find((x) => x.name === name);
  if (!asset) return null;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, {
    headers: headers({ Accept: "application/octet-stream" }),
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) throw new Error("asset redirect had no location");
    const blob = await fetch(loc);
    if (!blob.ok) throw new Error(`cannot fetch asset body: HTTP ${blob.status}`);
    return Buffer.from(await blob.arrayBuffer());
  }
  if (!res.ok) throw new Error(`cannot download ${name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------- hermes cli
function runHermes(args, { acceptCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(HERMES, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      err += d;
      process.stderr.write(d);
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (acceptCodes.includes(code)) resolve({ code, out, err });
      else reject(new Error(`${HERMES} ${args.join(" ")} exited ${code}`));
    });
  });
}

// ------------------------------------------------------------------- backup
async function backup() {
  if (!REPO) fail("BACKUP_REPO/GITHUB_REPOSITORY is not set");
  if (!TOKEN) fail("GITHUB_TOKEN/GH_PAT is not set");
  if (!PASSPHRASE) fail("BACKUP_ENCRYPTION_KEY is not set");

  const dir = await mkdtemp(join(tmpdir(), "hermes-state-"));
  const zip = join(dir, "hermes.zip");
  try {
    log("• hermes backup…");
    // Exit 1 means "backup incomplete but the zip was written" (a socket or an
    // unreadable file). That archive is still far better than none, so it is
    // accepted as long as it contains a usable amount of data.
    const { code } = await runHermes(["backup", "-o", zip], { acceptCodes: [0, 1] });
    const info = await stat(zip);
    log(`• archive: ${(info.size / 1024 / 1024).toFixed(2)} MiB (hermes exit ${code})`);
    if (info.size < MIN_BYTES) fail(`the archive is only ${info.size} bytes — refusing to publish`);

    const bytes = await readFile(zip);
    const sealed = seal(bytes);

    const current = await downloadAsset(ASSET).catch(() => null);
    if (current && current.length > MIN_BYTES) await uploadAsset(PREV, current);
    await uploadAsset(ASSET, sealed);
    log("• Hermes state is safe.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ restore
async function restore() {
  if (!REPO) fail("BACKUP_REPO/GITHUB_REPOSITORY is not set");
  if (!TOKEN) fail("GITHUB_TOKEN/GH_PAT is not set");
  if (!PASSPHRASE) fail("BACKUP_ENCRYPTION_KEY is not set");

  const newest = await downloadAsset(ASSET).catch((e) => {
    log(`• newest snapshot unavailable (${e.message}); trying the previous one`);
    return null;
  });
  const older = newest ? null : await downloadAsset(PREV).catch(() => null);
  const candidate = newest ?? older;
  if (!candidate) {
    log("• no Hermes snapshot yet — starting from a fresh home");
    return;
  }

  let zipBytes;
  try {
    zipBytes = unseal(candidate);
  } catch (e) {
    fail(`cannot decrypt the Hermes snapshot: ${e.message}`);
  }

  const dir = await mkdtemp(join(tmpdir(), "hermes-restore-"));
  const zip = join(dir, "hermes.zip");
  try {
    await writeFile(zip, zipBytes);
    log(`• hermes import (${(zipBytes.length / 1024 / 1024).toFixed(2)} MiB)…`);
    await runHermes(["import", zip, "--force"]);
    log("• Hermes state restored.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const command = process.argv[2];
if (command === "backup") await backup();
else if (command === "restore") await restore();
else {
  console.error("usage: node scripts/hermes/state.mjs backup|restore");
  process.exit(2);
}
