#!/bin/bash
# Updates this folder to the latest version of the extension on GitHub.
#
# macOS: double-click it in Finder. Anywhere else: run ./update.command
#
#   - In a git clone it fast-forwards the current branch (git pull --ff-only)
#     and refuses to touch anything if that isn't a clean fast-forward.
#   - In a plain download (the ZIP from GitHub) it downloads the main branch
#     and makes this folder match it, deleting files that are gone upstream.
#
# Chrome keeps running the old copy until you reload the extension at
# chrome://extensions.

REPO="yarbro/youtube-preview-pin"
BRANCH="main"
TMP_DIR=""

# Everything runs inside main() so bash has read the whole file before the
# update replaces it on disk.
main() {
  set -u
  cd "$(dirname "$0")" || fail "Can't open the folder this script lives in."

  # Never replace files in a folder that isn't the extension.
  grep -q '"name": "YouTube Preview Pin"' manifest.json 2>/dev/null ||
    fail "This doesn't look like the YouTube Preview Pin folder (no matching manifest.json)."

  local before after
  before=$(version)

  if [ -e .git ] && command -v git >/dev/null 2>&1; then
    update_with_git
  else
    update_from_download
  fi

  after=$(version)
  echo
  if [ "$before" = "$after" ]; then
    echo "Up to date (version $after)."
  else
    echo "Updated from version $before to $after."
  fi
  echo "Reload the extension at chrome://extensions to start using it."
}

version() {
  sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -n 1
}

fail() {
  echo "Update failed: $1" >&2
  exit 1
}

update_with_git() {
  echo "Updating with git..."
  git pull --ff-only ||
    fail "git couldn't fast-forward. Commit, stash or discard your local changes, then run this again."
}

update_from_download() {
  command -v curl >/dev/null 2>&1 || fail "curl is needed to download the update."
  command -v tar  >/dev/null 2>&1 || fail "tar is needed to unpack the update."

  TMP_DIR=$(mktemp -d) || fail "Couldn't create a temporary folder."
  trap 'rm -rf "$TMP_DIR"' EXIT
  local tmp="$TMP_DIR"

  echo "Downloading the latest version from github.com/$REPO..."
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" -o "$tmp/latest.tar.gz" ||
    fail "The download failed. Check your internet connection."

  mkdir "$tmp/latest" &&
    tar -xzf "$tmp/latest.tar.gz" -C "$tmp/latest" --strip-components=1 ||
    fail "The download couldn't be unpacked."

  # Don't replace a working copy with a broken or unexpected download.
  grep -q '"name": "YouTube Preview Pin"' "$tmp/latest/manifest.json" 2>/dev/null ||
    fail "The download doesn't look like the extension. Nothing was changed."

  echo "Replacing the files in $(pwd)..."
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude '.git' --exclude '.DS_Store' "$tmp/latest/" ./ ||
      fail "Copying the new files failed part-way. Run this again."
  else
    # No rsync: copy over the top. Files removed upstream are left behind.
    cp -R "$tmp/latest/." ./ || fail "Copying the new files failed part-way. Run this again."
  fi
}

main "$@"
exit
