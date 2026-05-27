#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET="${1:-native}"
TARGET="${TARGET#--}"
TARGET="${TARGET#-}"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found; Rust injector is required for desktop packaging." >&2
  echo "Install Rust first: https://rustup.rs/" >&2
  exit 127
fi

ensure_rust_target() {
  local triple="$1"
  if rustup target list --installed 2>/dev/null | grep -Fxq "$triple"; then
    return
  fi
  if ! command -v rustup >/dev/null 2>&1; then
    echo "Rust target is not installed: $triple" >&2
    echo "Install it first: rustup target add $triple" >&2
    exit 1
  fi
  echo "==> Installing missing Rust target: $triple"
  rustup target add "$triple"
}

should_skip_target_build() {
  local triple="$1"
  if [[ "$triple" == *-pc-windows-msvc ]] && ! command -v link.exe >/dev/null 2>&1; then
    echo "Skipping optional Rust injector for $triple: MSVC linker link.exe was not found." >&2
    echo "Windows packages will use the built-in JavaScript CDP injector fallback." >&2
    return 0
  fi
  return 1
}

mkdir -p dist/bin

copy_checked() {
  local src="$1"
  local dest="$2"
  if [[ ! -f "$src" ]]; then
    echo "Rust injector build did not produce expected binary: $src" >&2
    exit 1
  fi
  cp "$src" "$dest"
  if [[ ! -f "$dest" ]]; then
    echo "Failed to copy Rust injector to: $dest" >&2
    exit 1
  fi
}

build_native() {
  cargo build --release --manifest-path rust/csb-injector/Cargo.toml
  local suffix=""
  if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
    suffix=".exe"
  fi
  copy_checked "rust/csb-injector/target/release/csb-injector${suffix}" "dist/bin/csb-injector${suffix}"
}

build_target() {
  local triple="$1"
  local suffix="$2"
  if should_skip_target_build "$triple"; then
    return
  fi
  ensure_rust_target "$triple"
  cargo build --release --manifest-path rust/csb-injector/Cargo.toml --target "$triple"
  copy_checked "rust/csb-injector/target/${triple}/release/csb-injector${suffix}" "dist/bin/csb-injector${suffix}"
}

case "$TARGET" in
  native)
    build_native
    ;;
  mac|darwin)
    case "${MAC_ARCH:-arm64}" in
      arm64) build_target aarch64-apple-darwin "" ;;
      x64) build_target x86_64-apple-darwin "" ;;
      *)
        echo "Unsupported MAC_ARCH: ${MAC_ARCH:-} (use arm64 or x64)" >&2
        exit 1
        ;;
    esac
    ;;
  win|windows)
    case "${WIN_ARCH:-x64}" in
      x64) build_target x86_64-pc-windows-msvc ".exe" ;;
      arm64) build_target aarch64-pc-windows-msvc ".exe" ;;
      *)
        echo "Unsupported WIN_ARCH: ${WIN_ARCH:-} (use x64 or arm64)" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Usage: scripts/build-injector.sh [native|mac|win]" >&2
    exit 1
    ;;
esac
