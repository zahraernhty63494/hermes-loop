#!/usr/bin/env bash
# Tools that every fresh runner needs but that ~/.hermes does not carry.
#
# A GitHub runner is a brand-new VM on every handoff, so anything installed
# outside ~/.hermes is gone by the next session. This script reinstalls the
# small set of tools the agent relies on, idempotently, and never fails the
# boot: a missing tool is a warning, an uninstallable runner is not.
#
# Rules for adding a tool:
#   * guard it with `have <binary>` so a warm image costs nothing;
#   * keep it to seconds. Boot time is downtime (currently ~3m35s + extras);
#   * never write big models into ~/.hermes — the periodic snapshot uploads
#     the whole home every 15 minutes.
set -uo pipefail

log() { printf '\n== extras: %s ==\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "${HERMES_EXTRAS:-1}" = "0" ]; then
  log "skipped (HERMES_EXTRAS=0)"
  exit 0
fi

START=$(date +%s)

# -------------------------------------------------------------------- ffmpeg
if have ffmpeg; then
  log "ffmpeg already present"
else
  t0=$(date +%s)
  log "installing ffmpeg"
  sudo apt-get update -qq \
    && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg \
    || echo "::warning::ffmpeg install failed"
  echo "extras: ffmpeg done in $(( $(date +%s) - t0 ))s"
fi
have ffmpeg && ffmpeg -hide_banner -version 2>/dev/null | head -1

# --------------------------------------------------------------- whisper.cpp
# Built from source: the wheels pull in ~2.5 GB of torch, while this is ~1.5
# minutes and CPU-only. The model lives outside ~/.hermes on purpose.
WC=/opt/whisper.cpp
WHISPER_MODEL_NAME="${WHISPER_MODEL_NAME:-base}"
MODEL="$WC/models/ggml-${WHISPER_MODEL_NAME}.bin"

if [ -x "$WC/build/bin/whisper-cli" ]; then
  log "whisper.cpp already built"
else
  t0=$(date +%s)
  log "building whisper.cpp"
  sudo mkdir -p /opt && sudo chown "$(id -u):$(id -g)" /opt
  if [ ! -d "$WC/.git" ]; then
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$WC" \
      || echo "::warning::whisper.cpp clone failed"
  fi
  if [ -d "$WC/.git" ]; then
    cmake -S "$WC" -B "$WC/build" -DCMAKE_BUILD_TYPE=Release \
      -DWHISPER_BUILD_TESTS=OFF >/dev/null \
      && cmake --build "$WC/build" -j"$(nproc)" --target whisper-cli >/dev/null \
      || echo "::warning::whisper.cpp build failed"
  fi
  echo "extras: whisper.cpp done in $(( $(date +%s) - t0 ))s"
fi

if [ -x "$WC/build/bin/whisper-cli" ] && [ ! -s "$MODEL" ]; then
  t0=$(date +%s)
  log "downloading ggml-${WHISPER_MODEL_NAME}.bin"
  mkdir -p "$WC/models" 2>/dev/null || sudo mkdir -p "$WC/models"
  curl -fL --retry 3 --retry-delay 5 --max-time 600 \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL_NAME}.bin" \
    -o "$MODEL" || echo "::warning::whisper model download failed"
  echo "extras: ggml-${WHISPER_MODEL_NAME}.bin done in $(( $(date +%s) - t0 ))s"
fi

# A `whisper <audio>` wrapper the agent can call without remembering flags.
# Anything outside ~/.hermes is rebuilt here on every boot.
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/whisper" <<'WRAP'
#!/usr/bin/env bash
# Transcribe an audio file with whisper.cpp (installed by extras.sh).
# usage: whisper <audio-file> [extra whisper-cli args]
set -euo pipefail
bin=/opt/whisper.cpp/build/bin/whisper-cli
model="${WHISPER_MODEL_PATH:-/opt/whisper.cpp/models/ggml-base.bin}"
src="${1:?usage: whisper <audio-file> [whisper-cli args]}"; shift || true
[ -x "$bin" ] || { echo "whisper: whisper.cpp is not installed on this runner" >&2; exit 1; }
[ -s "$model" ] || { echo "whisper: model $model is missing" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
ffmpeg -hide_banner -loglevel error -y -i "$src" -ar 16000 -ac 1 -c:a pcm_s16le "$tmp/audio.wav"
"$bin" -m "$model" -f "$tmp/audio.wav" -nt -np "$@"
WRAP
chmod +x "$HOME/.local/bin/whisper"

if [ -x "$WC/build/bin/whisper-cli" ] && [ -s "$MODEL" ]; then
  log "whisper ready: $(command -v whisper)"
else
  echo "::warning::whisper is not usable this session"
fi

echo "extras: finished in $(( $(date +%s) - START ))s"
