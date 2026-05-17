#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET="${1:-all}"
TARGET="${TARGET#--}"
TARGET="${TARGET#-}"
VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
REMOTE="${RELEASE_REMOTE:-origin}"

case "$TARGET" in
  mac|darwin|win|windows|all|both) ;;
  *)
    echo "Usage: npm run release:desktop [-- -mac|-win|-all]" >&2
    exit 1
    ;;
esac

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes before releasing." >&2
  git status --short >&2
  exit 1
fi

echo "==> Running checks"
npm run check

echo "==> Building desktop packages (${TARGET})"
npm run build:desktop -- "$TARGET"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally."
else
  git tag -a "$TAG" -m "Codex Session Bridge $TAG"
fi

echo "==> Pushing branch and tag"
git push "$REMOTE" HEAD
git push "$REMOTE" "$TAG"

mapfile -t ASSETS < <(find release -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.zip' -o -name '*.exe' \) -print | sort)

if command -v gh >/dev/null 2>&1; then
  echo "==> Publishing GitHub Release $TAG"
  if gh release view "$TAG" >/dev/null 2>&1; then
    if (( ${#ASSETS[@]} > 0 )); then
      gh release upload "$TAG" "${ASSETS[@]}" --clobber
    fi
  else
    gh release create "$TAG" "${ASSETS[@]}" --title "Codex Session Bridge $TAG" --notes "Desktop release $TAG"
  fi
else
  echo "GitHub CLI (gh) is not installed. Branch and tag were pushed; upload assets manually from release/:" >&2
  printf '  %s\n' "${ASSETS[@]}" >&2
fi

echo "Release flow complete for $TAG."
