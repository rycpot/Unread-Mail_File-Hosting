#!/bin/sh
# Installs or updates Unread Mail. Paste into Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/rycpot/unread-emails-notifier/claude/blissful-faraday-8ykg9h/install.sh | sh
#
# First run: downloads the extension into ~/UnreadMail and installs the local
# helper (needed for iCloud / Yahoo / AOL and for one-click updates). You then
# add the folder to Chrome once with "Load unpacked".
# Later runs: update the existing folder in place, keeping src/config.js.
# Accounts and settings live in Chrome's storage and are never touched.
set -eu

REPO="rycpot/unread-emails-notifier"
BRANCH="claude/blissful-faraday-8ykg9h"
URL="${UNREAD_MAIL_ZIP_URL:-https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH}"

case "$(uname -s)" in
  Darwin) INFO="$HOME/Library/Application Support/UnreadMail/install.json" ;;
  *) INFO="$HOME/.local/share/unread-mail/install.json" ;;
esac

for tool in curl unzip python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is needed but was not found. On macOS run: xcode-select --install" >&2
    exit 1
  fi
done

# Update an existing install wherever it is; otherwise use ~/UnreadMail.
DEST=""
if [ -f "$INFO" ]; then
  DEST="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("extensionDir", ""))' "$INFO" 2>/dev/null || true)"
  [ -f "$DEST/manifest.json" ] || DEST=""
fi
DEST="${UNREAD_MAIL_DIR:-${DEST:-$HOME/UnreadMail}}"

FRESH=1
if [ -e "$DEST" ]; then
  if ! grep -q '"name": "Unread Mail"' "$DEST/manifest.json" 2>/dev/null; then
    echo "$DEST already exists and is not Unread Mail. Move it away (or set UNREAD_MAIL_DIR) and run this again." >&2
    exit 1
  fi
  FRESH=0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading Unread Mail…"
curl -fsSL "$URL" -o "$TMP/unread-mail.zip"
unzip -q "$TMP/unread-mail.zip" -d "$TMP/x"
SRC="$(find "$TMP/x" -mindepth 2 -maxdepth 2 -name manifest.json -exec dirname {} \; | head -n 1)"
if [ -z "$SRC" ]; then
  echo "The download did not contain the extension." >&2
  exit 1
fi

mkdir -p "$DEST"
# Your OAuth client IDs may be in src/config.js: keep it.
[ -f "$DEST/src/config.js" ] && rm -f "$SRC/src/config.js"
cp -R "$SRC/." "$DEST/"

if ! UNREAD_MAIL_INSTALLER=1 sh "$DEST/helper/install.sh"; then
  echo "The helper could not be installed; the extension itself is in place." >&2
fi
DEST="$(cd "$DEST" && pwd -P)" # install.sh may have moved it out of Downloads
VERSION="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$DEST/manifest.json" | head -n 1)"

if [ "$FRESH" = 1 ]; then
  echo
  echo "Unread Mail $VERSION is in $DEST"
  echo "Last step, in Chrome:"
  echo "  1. Open chrome://extensions and turn on Developer mode (top right)."
  echo "  2. Click Load unpacked, press Cmd+Shift+G, paste (Cmd+V) and press Return, then Select."
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$DEST" | pbcopy
    echo "     (The folder path is already copied.)"
  fi
  echo "Then follow docs/SETUP.md to connect your accounts."
else
  echo
  echo "Updated Unread Mail to $VERSION in $DEST"
  echo "Click reload (↻) on Unread Mail in chrome://extensions to use it."
fi
