#!/bin/sh
# Installs or updates Unread Mail & File Hosting. Paste into Terminal:
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

# Folders Chrome has loaded this extension from ("Load unpacked"), one per
# line, read from each Chrome / Chromium profile's settings.
chrome_paths() {
  python3 - "$HOME" <<'PY'
import glob, json, os, sys
home, ext_id = sys.argv[1], 'gnkolniepchhhfhnopbhgbnedkplhjjj'
roots = ['Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium',
         '.config/google-chrome', '.config/chromium']
found = []
for root in roots:
    for f in sorted(glob.glob(os.path.join(home, root, '*', '*Preferences'))):
        try:
            with open(f, encoding='utf-8') as fh:
                prefs = json.load(fh)
            path = prefs['extensions']['settings'][ext_id]['path']
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if os.path.isabs(path) and os.path.isfile(os.path.join(path, 'manifest.json')) and path not in found:
            found.append(path)
print('\n'.join(found))
PY
}
real() { (cd "$1" 2>/dev/null && pwd -P); }
# Prints something if Chrome loads the extension from folder $1.
in_use() { chrome_paths | while read -r p; do [ "$(real "$p")" = "$(real "$1")" ] && echo yes; done; true; }

# Which folder to install into, in order: UNREAD_MAIL_DIR; the folder Chrome
# actually loads (so a copy loaded from a downloaded ZIP is the one updated);
# the folder recorded by an earlier install; ~/UnreadMail.
LOADED="$(chrome_paths 2>/dev/null | head -n 1 || true)"
RECORDED=""
if [ -f "$INFO" ]; then
  RECORDED="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("extensionDir", ""))' "$INFO" 2>/dev/null || true)"
  [ -f "$RECORDED/manifest.json" ] || RECORDED=""
fi
DEST="${UNREAD_MAIL_DIR:-${LOADED:-${RECORDED:-$HOME/UnreadMail}}}"

# A copy loaded from Downloads, Documents or Desktop gets moved to ~/UnreadMail
# by the helper installer (macOS blocks updates there). If ~/UnreadMail is an
# unused second copy from an earlier install, set it aside first.
if [ "$(uname -s)" = Darwin ]; then
  case "$(real "$DEST")" in
    "$HOME/Downloads/"*|"$HOME/Documents/"*|"$HOME/Desktop/"*)
      SPARE="$HOME/UnreadMail"
      if [ -d "$SPARE" ] && [ ! -L "$SPARE" ] && grep -q '"name": "Unread Mail' "$SPARE/manifest.json" 2>/dev/null \
        && [ -z "$(in_use "$SPARE")" ]; then
        OLD="$SPARE-unused-$(date +%Y%m%d-%H%M%S)"
        mv "$SPARE" "$OLD"
        echo "Chrome uses the copy in $DEST, so the unused copy in $SPARE was moved to $OLD (you can delete it)."
      fi
      ;;
  esac
fi

FRESH=1
if [ -e "$DEST" ]; then
  if ! grep -q '"name": "Unread Mail' "$DEST/manifest.json" 2>/dev/null; then
    echo "$DEST already exists and is not Unread Mail & File Hosting. Move it away (or set UNREAD_MAIL_DIR) and run this again." >&2
    exit 1
  fi
  FRESH=0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading Unread Mail & File Hosting…"
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

if ! UNREAD_MAIL_INSTALLER=1 sh "$DEST/helper/install.sh" </dev/null; then
  echo "The helper could not be installed; the extension itself is in place." >&2
fi
DEST="$(cd "$DEST" && pwd -P)" # install.sh may have moved it out of Downloads
VERSION="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$DEST/manifest.json" | head -n 1)"

if [ "$FRESH" = 1 ]; then
  echo
  echo "Unread Mail & File Hosting $VERSION is in $DEST"
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
  echo "Updated Unread Mail & File Hosting to $VERSION in $DEST"
  echo "Click reload (↻) on Unread Mail & File Hosting in chrome://extensions to use it."
fi
