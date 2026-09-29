#!/bin/sh
# Installs the Unread Mail IMAP helper and registers it with Chrome.
# Safe to re-run; run it again after each update so the installed copy is current.
set -eu

HOST_NAME="com.unreadmail.imap"
EXTENSION_ID="gnkolniepchhhfhnopbhgbnedkplhjjj"
HERE="$(cd "$(dirname "$0")" && pwd)"

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
if printf '\016\000\000\000{"cmd":"ping"}' | "$LAUNCHER" | tail -c +5 | grep -q '"version"'; then
  echo "Unread Mail IMAP helper installed (python: $PYTHON)."
  echo "Reload the extension in chrome://extensions if it is open."
else
  echo "Installed, but the self-test failed. Check that $PYTHON runs." >&2
  exit 1
fi
