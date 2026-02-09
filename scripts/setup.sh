#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WHISPER_DIR="$REPO_ROOT/tools/whisper.cpp"
BUILD_DIR="$WHISPER_DIR/build"

SYSTEM_BIN_DIR="/usr/local/bin"
SYSTEM_SHARE_DIR="/usr/local/share/whisper.cpp"
SYSTEM_MODEL_PATH="$SYSTEM_SHARE_DIR/ggml-base.bin"

if [[ ! -f /etc/arch-release ]]; then
  echo "This setup script currently supports Arch Linux only."
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required."
  exit 1
fi

echo "Installing system packages..."
sudo pacman -S --needed --noconfirm \
  ffmpeg \
  base-devel \
  cmake \
  pkgconf \
  git

if [[ ! -d "$WHISPER_DIR" ]]; then
  echo "whisper.cpp not found, cloning into $WHISPER_DIR ..."
  mkdir -p "$REPO_ROOT/tools"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
fi

echo "Building whisper.cpp..."
cmake -S "$WHISPER_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR" -j"$(nproc)"

WHISPER_CLI_PATH="$BUILD_DIR/bin/whisper-cli"
if [[ ! -x "$WHISPER_CLI_PATH" ]]; then
  echo "whisper-cli binary not found at: $WHISPER_CLI_PATH"
  exit 1
fi

MODEL_SOURCE="$WHISPER_DIR/models/ggml-base.bin"
if [[ ! -f "$MODEL_SOURCE" ]]; then
  echo "Downloading ggml-base.bin model..."
  (cd "$WHISPER_DIR/models" && bash ./download-ggml-model.sh base)
fi

if [[ ! -f "$MODEL_SOURCE" ]]; then
  echo "Model file missing after download attempt: $MODEL_SOURCE"
  exit 1
fi

echo "Installing whisper.cpp artifacts system-wide..."
sudo install -d "$SYSTEM_BIN_DIR" "$SYSTEM_SHARE_DIR"
sudo install -m 0755 "$WHISPER_CLI_PATH" "$SYSTEM_BIN_DIR/whisper-cli"
sudo install -m 0644 "$MODEL_SOURCE" "$SYSTEM_MODEL_PATH"

cat <<EOF
Done.

Use these env vars in your .env:
WHISPER_CLI_PATH=$SYSTEM_BIN_DIR/whisper-cli
WHISPER_MODEL_PATH=$SYSTEM_MODEL_PATH
FFMPEG_PATH=ffmpeg
EOF
