#!/usr/bin/env bash
# Bring Hermes up on a fresh GitHub runner, on top of the 9router that
# router.mjs already installed behind its VPN lock.
#
#   install  ->  restore  ->  extras  ->  pin the model  ->  secrets  ->  gateway
#
# Everything that must survive the 6-hour job boundary lives in the encrypted
# release asset restored here; nothing is written to the repository.
set -euo pipefail

log() { printf '\n== %s ==\n' "$*"; }

export PATH="$HOME/.local/bin:$PATH"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

MODEL="${HERMES_MODEL:-oc/deepseek-v4.1-flash-free}"
BASE_URL="${NINE_ROUTER_BASE_URL:-http://127.0.0.1:20128/v1}"
CONTEXT="${HERMES_CONTEXT_LENGTH:-200000}"
KEY_FILE="${NINE_KEY_FILE:?NINE_KEY_FILE is not set}"

log "install"
if [ ! -x "$HOME/.local/bin/hermes" ]; then
  for attempt in 1 2; do
    if curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
        | bash -s -- --non-interactive --skip-browser --skip-computer-use; then
      break
    fi
    echo "installer failed (attempt ${attempt}); retrying in 20s" >&2
    sleep 20
  done
fi
if [ ! -x "$HOME/.local/bin/hermes" ]; then
  echo "::error::Hermes did not install (~/.local/bin/hermes is missing)"
  exit 1
fi
hermes --version

log "restore"
node scripts/hermes/state.mjs restore

log "extras"
# Rebuilds the tools a fresh runner has to have (ffmpeg, whisper.cpp). Never
# fatal: a failed install costs a capability, not the session.
bash scripts/hermes/extras.sh || echo "::warning::extras failed; the session starts without them"

log "pin the model"
mkdir -p "$HERMES_HOME"
# `hermes config set` writes dotted keys to config.yaml (and validates them)
# and leaves everything the restored home already configured in place.
hermes config unset model.api_key >/dev/null 2>&1 || true
hermes config unset model.model >/dev/null 2>&1 || true
hermes config set model.provider custom
hermes config set model.default "$MODEL"
hermes config set model.base_url "$BASE_URL"
hermes config set model.key_env NINE_ROUTER_API_KEY
hermes config set model.context_length "$CONTEXT"

# The bot must answer messages that arrived while the previous runner was
# backing up and dispatching this one. Cosmetic settings are best-effort: a
# schema change in a future release must not keep the runner from starting.
hermes config set platforms.telegram.extra.drop_pending_on_cold_boot false \
  || echo "::warning::could not pin drop_pending_on_cold_boot"

# Free-tier tokens are the scarce resource here: the post-turn self-review and
# the auto-title calls would each double the traffic. Memory and skills still
# work; only the automatic forks are off.
hermes config set auxiliary.background_review.enabled false \
  || echo "::warning::could not disable the background review"
hermes config set auxiliary.title_generation.enabled false \
  || echo "::warning::could not disable automatic titles"

log "secrets"
NINE_ROUTER_API_KEY="$(tr -d '\r\n' < "$KEY_FILE")" \
  node scripts/hermes/env.mjs

log "verify"
hermes config get model.provider
hermes config get model.default
hermes config get model.base_url
hermes config get model.context_length

log "gateway"
rm -f "$HOME/hermes-gateway.log"
setsid nohup hermes gateway run >>"$HOME/hermes-gateway.log" 2>&1 &
GATEWAY_PID=$!
echo "$GATEWAY_PID" > "$HOME/hermes-gateway.pid"
echo "gateway pid ${GATEWAY_PID}"

ready=0
dead=0
for _ in $(seq 1 90); do
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    dead=1
    break
  fi
  if grep -qiE 'telegram.*(connect|poll|start)|connected to telegram' "$HOME/hermes-gateway.log" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done

if [ "$dead" = 1 ]; then
  echo "::error::the gateway exited during startup"
  tail -60 "$HOME/hermes-gateway.log" 2>/dev/null || true
  exit 1
fi

if [ "$ready" = 1 ]; then
  echo "✓ gateway connected to Telegram"
else
  # The process is alive but the log line has not appeared yet (log wording
  # changes between releases). Do not kill a working runner over a grep.
  echo "::warning::no Telegram connection line within 180s — continuing; the log follows"
fi
tail -40 "$HOME/hermes-gateway.log" 2>/dev/null || true

log "end-to-end"
# One real turn through 9router proves the whole path (Hermes -> 9router ->
# zen-proxy -> model). A free-tier 429 here is not fatal: the runner still
# comes up and the next message retries, but the owner is told about it.
if timeout 240 hermes -z "Reply with the single word: ok" >"$HOME/hermes-selftest.txt" 2>"$HOME/hermes-selftest.err"; then
  echo "✓ model answered: $(tr -d '\r\n' < "$HOME/hermes-selftest.txt" | cut -c1-80)"
else
  code=$?
  echo "::warning::the model self-test failed (exit ${code}); see ~/hermes-selftest.err"
  tail -20 "$HOME/hermes-selftest.err" 2>/dev/null || true
fi
