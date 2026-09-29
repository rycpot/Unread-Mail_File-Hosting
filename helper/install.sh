#!/bin/sh
# Installs the Unread Mail IMAP helper and registers it with Chrome.
# Safe to re-run; run it again after each update so the installed copy is current.
set -eu

HOST_NAME="com.unreadmail.imap"
EXTENSION_ID="gnkolniepchhhfhnopbhgbnedkplhjjj"
HERE="$(cd "$(dirname "$0")" && pwd -P)"

# macOS protects Downloads, Documents and Desktop from helper programs, so
# "Install update" could not write the extension there. Move the folder to
# ~/UnreadMail and leave a link at the old path: Chrome (which loaded the old
# path), the installer and your accounts carry on unchanged.
EXT_DIR="$(cd "$HERE/.." && pwd -P)"
if [ "$(uname -s)" = Darwin ] && [ -f "$EXT_DIR/manifest.json" ]; then
  case "$EXT_DIR" in
    "$HOME/Downloads/"*|"$HOME/Documents/"*|"$HOME/Desktop/"*)
      TARGET="$HOME/UnreadMail"
      if [ -e "$TARGET" ]; then
        echo "Note: $EXT_DIR is in a folder macOS protects, so one-click updates can't write to it," >&2
        echo "and $TARGET already exists. Move the extension folder out of it yourself." >&2
      else
        mv "$EXT_DIR" "$TARGET"
        ln -s "$TARGET" "$EXT_DIR"
        echo "Moved the extension folder to $TARGET (macOS protects $(dirname "$EXT_DIR"));"
        echo "$EXT_DIR now links to it, so Chrome keeps working."
        EXT_DIR="$TARGET"
        HERE="$TARGET/helper"
      fi
      ;;
  esac
fi

PYTHON="$(command -v python3 || true)"
if [ -z "$PYTHON" ]; then
  echo "python3 was not found. On macOS run: xcode-select --install" >&2
  exit 1
fi
# Chrome starts the helper with a minimal PATH, so pin the absolute interpreter.
PYTHON="$(cd "$(dirname "$PYTHON")" && pwd)/$(basename "$PYTHON")"

case "$(uname -s)" in
  Darwin)
    INSTALL_DIR="$HOME/Library/Application Support/UnreadMail"
    MANIFEST_DIRS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  *)
    INSTALL_DIR="$HOME/.local/share/unread-mail"
    MANIFEST_DIRS="$HOME/.config/google-chrome/NativeMessagingHosts:$HOME/.config/chromium/NativeMessagingHosts"
    ;;
esac
# Extra target, e.g. a test browser profile's NativeMessagingHosts directory.
if [ -n "${UNREAD_MAIL_EXTRA_MANIFEST_DIR:-}" ]; then
  MANIFEST_DIRS="$MANIFEST_DIRS:$UNREAD_MAIL_EXTRA_MANIFEST_DIR"
fi

mkdir -p "$INSTALL_DIR"
cp "$HERE/unread_mail_imap.py" "$INSTALL_DIR/unread_mail_imap.py"

LAUNCHER="$INSTALL_DIR/unread-mail-imap"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$PYTHON" "$INSTALL_DIR/unread_mail_imap.py" "\$@"
EOF
chmod 755 "$LAUNCHER"

# Remember the extension folder, so "Install update" in the app can update it.
if [ -f "$EXT_DIR/manifest.json" ]; then
  "$PYTHON" -c 'import json, sys; json.dump({"extensionDir": sys.argv[1]}, open(sys.argv[2], "w"))' \
    "$EXT_DIR" "$INSTALL_DIR/install.json"
fi

IFS=:
for dir in $MANIFEST_DIRS; do
  mkdir -p "$dir"
  cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Unread Mail IMAP helper",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
done
unset IFS

# Quick self-test: a ping through the same framing Chrome uses.
PING="$(printf '\016\000\000\000{"cmd":"ping"}' | "$LAUNCHER" | tail -c +5)"
if echo "$PING" | grep -q '"version"'; then
  echo "Unread Mail IMAP helper installed (python: $PYTHON)."
  if echo "$PING" | grep -q '"caCerts": 0[,}]'; then
    echo "Warning: this Python has no trusted certificates, so secure connections will fail." >&2
    echo "Run the 'Install Certificates.command' in your Python folder under /Applications." >&2
  fi
  [ -n "${UNREAD_MAIL_INSTALLER:-}" ] || echo "Reload the extension in chrome://extensions if it is open."
else
  echo "Installed, but the self-test failed. Check that $PYTHON runs." >&2
  exit 1
fi
