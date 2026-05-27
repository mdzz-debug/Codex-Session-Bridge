#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MAC_ARCH="${MAC_ARCH:-arm64}"
WIN_ARCH="${WIN_ARCH:-x64}"
TARGET="${1:-mac}"
TARGET="${TARGET#--}"
TARGET="${TARGET#-}"

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

run_with_retry() {
  local attempts="$1"
  shift
  local delay=5
  local attempt=1
  local exit_code=0

  while (( attempt <= attempts )); do
    if "$@"; then
      return 0
    fi
    exit_code=$?
    if (( attempt == attempts )); then
      break
    fi
    echo "Command failed; retrying in ${delay}s (${attempt}/${attempts})..."
    sleep "$delay"
    attempt=$((attempt + 1))
  done

  return "$exit_code"
}

electron_builder_with_fallback() {
  if run_with_retry 3 npx electron-builder "$@"; then
    return 0
  fi

  echo "Primary Electron mirror failed; retrying with GitHub release downloads..."
  ELECTRON_MIRROR="https://github.com/electron/electron/releases/download/" \
    ELECTRON_BUILDER_BINARIES_MIRROR="https://github.com/electron-userland/electron-builder-binaries/releases/download/" \
    run_with_retry 3 npx electron-builder "$@"
}

case "$MAC_ARCH" in
  arm64) GO_MAC_ARCH="arm64" ;;
  x64) GO_MAC_ARCH="amd64" ;;
  *)
    echo "Unsupported MAC_ARCH: $MAC_ARCH (use arm64 or x64)" >&2
    exit 1
    ;;
esac

case "$WIN_ARCH" in
  x64) GO_WIN_ARCH="amd64" ;;
  arm64) GO_WIN_ARCH="arm64" ;;
  *)
    echo "Unsupported WIN_ARCH: $WIN_ARCH (use x64 or arm64)" >&2
    exit 1
    ;;
esac

case "$TARGET" in
  mac|darwin) BUILD_MAC=true; BUILD_WIN=false ;;
  win|windows) BUILD_MAC=false; BUILD_WIN=true ;;
  all|both) BUILD_MAC=true; BUILD_WIN=true ;;
  *)
    echo "Usage: npm run build:desktop [-- -mac|-win|-all]" >&2
    echo "Also accepts: mac, win, all, --mac, --win, --all." >&2
    echo "Default target is mac." >&2
    exit 1
    ;;
esac

echo "==> Building web UI"
npm run build:web

echo "==> Building daemon binaries"
rm -rf dist/bin
mkdir -p dist/bin
if [[ "$BUILD_MAC" == "true" ]]; then
  GOOS=darwin GOARCH="$GO_MAC_ARCH" go build -o dist/bin/csb-daemon ./cmd/csb-daemon
fi
if [[ "$BUILD_WIN" == "true" ]]; then
  GOOS=windows GOARCH="$GO_WIN_ARCH" go build -o dist/bin/csb-daemon.exe ./cmd/csb-daemon
fi

echo "==> Building Rust injector"
if [[ "$BUILD_MAC" == "true" ]]; then
  npm run build:injector -- mac
  if [[ ! -f dist/bin/csb-injector ]]; then
    echo "Missing required packaged Rust injector: dist/bin/csb-injector" >&2
    exit 1
  fi
fi
if [[ "$BUILD_WIN" == "true" ]]; then
  npm run build:injector -- win
  if [[ ! -f dist/bin/csb-injector.exe ]]; then
    echo "Missing required packaged Rust injector: dist/bin/csb-injector.exe" >&2
    exit 1
  fi
fi

if [[ "$BUILD_MAC" == "true" ]]; then
  echo "==> Packaging macOS ($MAC_ARCH)"
  electron_builder_with_fallback --mac zip "--$MAC_ARCH"

  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "==> Creating macOS DMG with hdiutil"
    DMG_NAME="Codex Session Bridge-$(node -p "require('./package.json').version")-${MAC_ARCH}.dmg"
    APP_PATH="release/mac-${MAC_ARCH}/Codex Session Bridge.app"
    STAGING_DIR="$(mktemp -d)"
    cp -R "$APP_PATH" "$STAGING_DIR/"
    ln -s /Applications "$STAGING_DIR/Applications"
    hdiutil create -volname "Codex Session Bridge" -srcfolder "$STAGING_DIR" -ov -format UDZO "release/$DMG_NAME"
    hdiutil verify "release/$DMG_NAME"
    rm -rf "$STAGING_DIR"
  else
    echo "Skipping DMG creation because hdiutil is only available on macOS."
  fi
fi

if [[ "$BUILD_WIN" == "true" ]]; then
  echo "==> Packaging Windows ($WIN_ARCH)"
  electron_builder_with_fallback --win nsis "--$WIN_ARCH"
fi

echo
echo "Desktop packages are ready:"
find release -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.zip' -o -name '*.exe' \) -print | sort
