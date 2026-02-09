#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_TEMPLATE_DIR="$REPO_ROOT/defaults/workspace"
WORKSPACE_DIR="${OKA_WORKSPACE_DIR:-${RELAY_DIR:-$REPO_ROOT/.oka}}"
WHISPER_DIR="$REPO_ROOT/tools/whisper.cpp"
BUILD_DIR="$WHISPER_DIR/build"

SYSTEM_BIN_DIR="/usr/local/bin"
SYSTEM_SHARE_DIR="/usr/local/share/whisper.cpp"
SYSTEM_MODEL_PATH="$SYSTEM_SHARE_DIR/ggml-base.bin"

if [[ "$WORKSPACE_DIR" == "~/"* ]]; then
  WORKSPACE_DIR="$HOME/${WORKSPACE_DIR#~/}"
fi

if [[ "$WORKSPACE_DIR" != /* ]]; then
  WORKSPACE_DIR="$REPO_ROOT/$WORKSPACE_DIR"
fi

copy_workspace_defaults() {
  if [[ ! -d "$WORKSPACE_TEMPLATE_DIR" ]]; then
    echo "Workspace template directory missing: $WORKSPACE_TEMPLATE_DIR"
    exit 1
  fi

  echo "Initializing workspace defaults in: $WORKSPACE_DIR"
  mkdir -p "$WORKSPACE_DIR"

  (
    cd "$WORKSPACE_TEMPLATE_DIR"
    find . -type d -exec mkdir -p "$WORKSPACE_DIR/{}" \;
    find . -type f | while IFS= read -r file; do
      rel_path="${file#./}"
      target="$WORKSPACE_DIR/$rel_path"
      if [[ -f "$target" ]]; then
        continue
      fi
      cp "$file" "$target"
      echo "  created: $target"
    done
  )
}

install_whisper_arch() {
  if [[ ! -f /etc/arch-release ]]; then
    echo "Skipping whisper.cpp install: Arch Linux not detected."
    return
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required for whisper.cpp install."
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
Whisper install complete.

Use these env vars in your .env:
WHISPER_CLI_PATH=$SYSTEM_BIN_DIR/whisper-cli
WHISPER_MODEL_PATH=$SYSTEM_MODEL_PATH
FFMPEG_PATH=ffmpeg
EOF
}

copy_workspace_defaults

if [[ "${SKIP_WHISPER_SETUP:-false}" == "true" ]]; then
  echo "Skipping whisper setup because SKIP_WHISPER_SETUP=true."
else
  install_whisper_arch
fi

cat <<EOF
Done.

Workspace initialized at: $WORKSPACE_DIR
EOF
