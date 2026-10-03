#!/usr/bin/env python3
"""Unread Mail IMAP helper (Chrome native messaging host).

Chrome starts this program when the extension calls
chrome.runtime.connectNative('com.unreadmail.imap'). It reads one JSON request
from stdin, talks IMAP over TLS to the mail server, writes one or more JSON
replies to stdout, then exits. It is not a server and never runs on its own.

Only unread mail is touched:
  * listing uses EXAMINE (read-only) and SEARCH UNSEEN, then fetches only the
    From/Subject/Date headers of the newest unread messages;
  * a body is fetched with BODY.PEEK[] only when the user opens that email, so
    reading never sets \\Seen by itself;
  * nothing is cached on disk.

App-specific passwords are kept in the macOS Keychain (service
"unread-mail-imap"). Standard library only.
"""

import base64
import email
import email.header
import email.policy
import email.utils
import imaplib
import io
import json
import os
import re
import smtplib
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile

VERSION = 8
KEYCHAIN_SERVICE = 'unread-mail-imap'
# Replies to Chrome are limited to 1 MB each; larger payloads are split.
CHUNK_CHARS = 600_000
STORE_BATCH = 500

SERVERS = {
    'icloud': ('imap.mail.me.com', 993),
    'yahoo': ('imap.mail.yahoo.com', 993),
    'aol': ('imap.aol.com', 993),
}

# Outgoing mail, with the same app password. (host, port, implicit TLS)
SMTP_SERVERS = {
    'icloud': ('smtp.mail.me.com', 587, False),  # STARTTLS
    'yahoo': ('smtp.mail.yahoo.com', 465, True),
    'aol': ('smtp.aol.com', 465, True),
}
# Yahoo and AOL file what is sent through SMTP in Sent themselves; iCloud
# does not, so the helper saves a copy there.
SAVES_SENT_ITSELF = {'yahoo', 'aol'}


class HelperError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# ---------- native messaging framing ----------

def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack('<I', raw_len)
    return json.loads(sys.stdin.buffer.read(length).decode('utf-8'))


_send_lock = threading.Lock()


def send(obj):
    data = json.dumps(obj).encode('utf-8')
    with _send_lock:  # watcher threads share stdout
        sys.stdout.buffer.write(struct.pack('<I', len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def reply(result):
    """Send the final result, splitting it into chunks if it is large."""
    text = json.dumps(result)
    if len(text) <= CHUNK_CHARS:
        send({'done': True, 'result': result})
        return
    for i in range(0, len(text), CHUNK_CHARS):
        send({'chunk': text[i:i + CHUNK_CHARS], 'done': i + CHUNK_CHARS >= len(text)})


def progress(done, total):
    send({'progress': [done, total]})


# ---------- password storage ----------

def _secrets_file():
    # Non-macOS fallback, used for development only.
    path = os.path.join(os.path.expanduser('~'), '.config', 'unread-mail', 'secrets.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def _keychain_quote(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def set_password(account, password):
    if sys.platform == 'darwin':
        # `security -i` reads the command from stdin, so the password never
        # appears in the process list.
        cmd = 'add-generic-password -U -s {} -a {} -w {}\n'.format(
            _keychain_quote(KEYCHAIN_SERVICE), _keychain_quote(account), _keychain_quote(password))
        res = subprocess.run(['/usr/bin/security', '-i'], input=cmd, text=True, capture_output=True)
        if res.returncode != 0 or 'error' in res.stderr.lower():
            raise HelperError('keychain', 'Could not save the password to Keychain: ' + res.stderr.strip())
        return
    path = _secrets_file()
    data = json.load(open(path)) if os.path.exists(path) else {}
    data[account] = password
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        json.dump(data, f)


def get_password(account):
    if sys.platform == 'darwin':
        res = subprocess.run(
            ['/usr/bin/security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
            capture_output=True, text=True)
        if res.returncode != 0:
            raise HelperError('auth', 'No saved password for this account')
        return res.stdout.rstrip('\n')
    path = _secrets_file()
    data = json.load(open(path)) if os.path.exists(path) else {}
    if account not in data:
        raise HelperError('auth', 'No saved password for this account')
    return data[account]


def delete_password(account):
    if sys.platform == 'darwin':
        subprocess.run(['/usr/bin/security', 'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account],
                       capture_output=True)
        return
    path = _secrets_file()
    if os.path.exists(path):
        data = json.load(open(path))
        data.pop(account, None)
        with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
            json.dump(data, f)


# ---------- IMAP ----------

def server_for(provider):
    # Development override: UNREAD_MAIL_IMAP_OVERRIDE=host:port[:insecure]
    override = os.environ.get('UNREAD_MAIL_IMAP_OVERRIDE')
    if override:
        parts = override.split(':')
        return parts[0], int(parts[1]), len(parts) > 2 and parts[2] == 'insecure'
    if provider not in SERVERS:
        raise HelperError('bad_request', 'Unknown provider: ' + str(provider))
    host, port = SERVERS[provider]
    return host, port, False


# Python from python.org on macOS ships with no trusted root certificates until
# its "Install Certificates" script is run, so fall back to other sources of
# the same public roots instead of failing verification.
CA_FILES = ('/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt')


def tls_context():
    ctx = ssl.create_default_context()
    if ctx.cert_store_stats().get('x509_ca', 0):
        return ctx
    try:
        import certifi  # present if "Install Certificates.command" was run
        ctx.load_verify_locations(certifi.where())
        return ctx
    except (ImportError, OSError, ssl.SSLError):
        pass
    for path in CA_FILES:
        if os.path.exists(path):
            try:
                ctx.load_verify_locations(path)
                return ctx
            except (OSError, ssl.SSLError):
                continue
    if sys.platform == 'darwin':
        # Last resort: export Apple's built-in root store.
        res = subprocess.run(
            ['/usr/bin/security', 'find-certificate', '-a', '-p',
             '/System/Library/Keychains/SystemRootCertificates.keychain'],
            capture_output=True, text=True)
        if res.returncode == 0 and 'BEGIN CERTIFICATE' in res.stdout:
            ctx.load_verify_locations(cadata=res.stdout)
    return ctx


# Login replies that mean the email or app password itself was refused. Any
# other refused login (Yahoo's "Server error - Please try again later",
# too many connections, a dropped connection) is temporary and must not be
# shown as signed out.
CREDENTIALS_REJECTED = re.compile(
    r'AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|invalid credentials|authentication failed|'
    r'incorrect (?:username|password)|invalid (?:username|password)',
    re.IGNORECASE)
LOGIN_RETRY_DELAY_S = 3


def connect(provider, email_addr, password=None):
    host, port, insecure = server_for(provider)
    ctx = tls_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    if password is None:
        password = get_password(key(provider, email_addr))
    # A temporarily refused login is tried once more on a new connection; a
    # rejected password is reported at once (retrying it achieves nothing).
    for attempt in (1, 2):
        try:
            conn = imaplib.IMAP4_SSL(host, port, ssl_context=ctx, timeout=30)
        except OSError as e:
            raise HelperError('network', 'Could not reach {}: {}'.format(host, e))
        try:
            conn.login(email_addr, password)
            return conn
        except imaplib.IMAP4.error as e:
            reply = _text(e.args[0] if e.args else e)
            _logout(conn)
            if CREDENTIALS_REJECTED.search(reply):
                raise HelperError('auth', 'Login failed: ' + reply)
            if attempt == 2:
                raise HelperError('login', '{} refused the login for now: {}'.format(host, reply))
            time.sleep(LOGIN_RETRY_DELAY_S)


def key(provider, email_addr):
    return '{}:{}'.format(provider, email_addr.lower())


def _text(value):
    if isinstance(value, bytes):
        return value.decode('utf-8', 'replace')
    return str(value)


def check(typ, data, what):
    if typ != 'OK':
        raise HelperError('imap', '{} failed: {}'.format(what, _text(data[0] if data else '')))
    return data


def select_inbox(conn, readonly):
    return select_folder(conn, 'INBOX', readonly)


def select_folder(conn, name, readonly):
    typ, data = conn.select(name if name == 'INBOX' else quote_mailbox(name), readonly=readonly)
    check(typ, data, 'Opening {}'.format(name))
    typ, data = conn.response('UIDVALIDITY')
    return _text(data[0]) if data and data[0] else '0'


def open_folder(conn, req, readonly):
    """Selects the folder a request is about: the inbox, or with folder
    "spam", "sent" or "drafts" that folder. Returns its UIDVALIDITY."""
    folder = req.get('folder')
    if folder in FINDERS:
        return select_folder(conn, FINDERS[folder](conn), readonly)
    return select_inbox(conn, readonly)


def unseen_uids(conn):
    return search(conn, 'UNSEEN')


def search(conn, criterion):
    # Messages flagged \Deleted but not yet expunged are ignored everywhere.
    typ, data = conn.uid('SEARCH', None, criterion, 'UNDELETED')
    check(typ, data, 'Searching mail')
    return [int(u) for u in _text(data[0] or b'').split()]


def parse_ids(ids, uidvalidity):
    """Message ids are "<uidvalidity>-<uid>"; a changed UIDVALIDITY means the
    mailbox was rebuilt and the stored ids no longer point at the same mail."""
    uids = []
    for mid in ids:
        v, _, uid = str(mid).partition('-')
        if v != uidvalidity:
            raise HelperError('stale', 'The mailbox changed on the server. Refresh and try again.')
        uids.append(uid)
    return uids


def address(value):
    name, addr = email.utils.parseaddr(value or '')
    return {'name': name, 'email': addr}


def decode_header(value):
    if value is None:
        return ''
    return str(email.header.make_header(email.header.decode_header(value)))


def date_ms(date_header, fallback=None):
    try:
        return int(email.utils.parsedate_to_datetime(date_header).timestamp() * 1000)
    except (TypeError, ValueError, IndexError):
        return fallback


def fetch_headers(conn, uids, uidvalidity):
    """From/Subject/Date of the given messages only, newest first."""
    messages = []
    if not uids:
        return messages
    typ, data = conn.uid('FETCH', ','.join(str(u) for u in uids),
                         '(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])')
    check(typ, data, 'Fetching headers')
    for n, item in enumerate(data):
        if not isinstance(item, tuple):
            continue
        meta, raw = _text(item[0]), item[1]
        # Some servers send FLAGS after the header literal, in the next element.
        after = data[n + 1] if n + 1 < len(data) and not isinstance(data[n + 1], tuple) else b''
        flags = re.search(r'FLAGS \(([^)]*)\)', meta + ' ' + _text(after or b''))
        uid = re.search(r'UID (\d+)', meta)
        if not uid:
            continue
        internal = re.search(r'INTERNALDATE "([^"]+)"', meta)
        fallback = None
        if internal:
            parsed = imaplib.Internaldate2tuple(('INTERNALDATE "%s"' % internal.group(1)).encode())
            if parsed:
                fallback = int(time.mktime(parsed) * 1000)
        hdr = email.message_from_bytes(raw)
        messages.append({
            'id': '{}-{}'.format(uidvalidity, uid.group(1)),
            'from': address(decode_header(hdr.get('From'))),
            'to': addresses(hdr.get_all('To')),
            'subject': decode_header(hdr.get('Subject')),
            'date': date_ms(hdr.get('Date'), fallback) or fallback or 0,
            'read': bool(flags and '\\seen' in flags.group(1).lower()),
        })
    messages.sort(key=lambda m: m['date'], reverse=True)
    return messages


def cmd_summary(req):
    limit = int(req.get('limit', 30))
    conn = connect(req['provider'], req['email'])
    try:
        uidvalidity = select_inbox(conn, readonly=True)
        uids = unseen_uids(conn)
        # Highest UIDs are the most recently delivered.
        messages = fetch_headers(conn, sorted(uids)[-limit:], uidvalidity)
        return {'unreadCount': len(uids), 'messages': messages, 'spamUnread': spam_unread(conn)}
    finally:
        _logout(conn)


def cmd_recent_read(req):
    """The newest already-read inbox emails, fetched only when asked for."""
    limit = int(req.get('limit', 10))
    conn = connect(req['provider'], req['email'])
    try:
        uidvalidity = select_inbox(conn, readonly=True)
        uids = search(conn, 'SEEN')
        return {'messages': fetch_headers(conn, sorted(uids)[-limit:], uidvalidity)}
    finally:
        _logout(conn)


def fetch_raw(conn, uid):
    typ, data = conn.uid('FETCH', uid, '(FLAGS BODY.PEEK[])')
    check(typ, data, 'Fetching the email')
    for item in data:
        if isinstance(item, tuple):
            return _text(item[0]), item[1]
    raise HelperError('not_found', 'This email no longer exists. It may have been deleted elsewhere.')


def leaf_parts(msg):
    return [p for p in msg.walk() if not p.is_multipart()]


def leaf_sections(msg):
    """IMAP section numbers (RFC 3501 6.4.5) of the leaf parts, in the same
    order as leaf_parts(), so one attachment can be fetched on its own."""
    out = []

    def rec(part, path):
        if part.get_content_type() == 'message/rfc822' and part.is_multipart():
            inner = part.get_payload()[0]
            if inner.is_multipart():
                for i, child in enumerate(inner.get_payload(), 1):
                    rec(child, '{}.{}'.format(path, i))
            else:
                out.append('{}.1'.format(path))
        elif part.is_multipart():
            for i, child in enumerate(part.get_payload(), 1):
                rec(child, '{}.{}'.format(path, i) if path else str(i))
        else:
            out.append(path or '1')

    rec(msg, '')
    return out


def cmd_get_message(req):
    conn = connect(req['provider'], req['email'])
    try:
        uidvalidity = open_folder(conn, req, readonly=True)
        (uid,) = parse_ids([req['id']], uidvalidity)
        meta, raw = fetch_raw(conn, uid)
    finally:
        _logout(conn)
    return message_json(req['id'], meta, raw)


def cmd_get_messages(req):
    """Several emails of one folder in one session (for the offline cache).
    Emails that no longer exist are left out."""
    ids = list(req.get('ids') or [])[:25]
    out = []
    conn = connect(req['provider'], req['email'])
    try:
        uidvalidity = open_folder(conn, req, readonly=True)
        for mid in ids:
            try:
                (uid,) = parse_ids([mid], uidvalidity)
                meta, raw = fetch_raw(conn, uid)
                out.append(message_json(mid, meta, raw))
            except HelperError:
                continue
    finally:
        _logout(conn)
    return {'messages': out}


def cmd_get_attachments(req):
    """Several attachments of one email in one session; parts:
    [{ attachmentId, section, size }]. Returns { attachmentId: base64 }."""
    conn = connect(req['provider'], req['email'])
    out = {}
    try:
        uidvalidity = open_folder(conn, req, readonly=True)
        (uid,) = parse_ids([req['id']], uidvalidity)
        whole = None
        for p in req.get('parts') or []:
            payload = None
            section = p.get('section')
            if section and re.fullmatch(r'\d+(\.\d+)*', str(section)):
                payload = _fetch_section(conn, uid, section)
                if payload is not None and p.get('size') is not None and len(payload) != int(p['size']):
                    payload = None
            if payload is None:
                if whole is None:
                    whole = leaf_parts(email.message_from_bytes(fetch_raw(conn, uid)[1], policy=email.policy.default))
                index = int(p['attachmentId'])
                payload = (whole[index].get_payload(decode=True) or b'') if index < len(whole) else b''
            out[str(p['attachmentId'])] = base64.b64encode(payload).decode('ascii')
    finally:
        _logout(conn)
    return {'attachments': out}


def message_json(mid, meta, raw):
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    html_part = msg.get_body(preferencelist=('html',))
    text_part = msg.get_body(preferencelist=('plain',))
    body_parts = {id(p) for p in (html_part, text_part) if p is not None}
    html_source = ''
    if html_part is not None:
        try:
            html_source = html_part.get_content()
        except (LookupError, UnicodeDecodeError):
            html_source = ''
    attachments = []
    sections = leaf_sections(msg)
    for index, part in enumerate(leaf_parts(msg)):
        if id(part) in body_parts:
            continue
        payload = part.get_payload(decode=True) or b''
        content_id = (part.get('Content-ID') or '').strip().strip('<>') or None
        disposition = (part.get_content_disposition() or '')
        # Some senders mark embedded images as attachments; what matters is
        # whether the HTML references the part by its Content-ID.
        inline = bool(content_id) and (('cid:' + content_id) in html_source or disposition == 'inline')
        attachments.append({
            'id': str(index),
            'section': sections[index] if index < len(sections) else None,
            'filename': part.get_filename() or content_id or 'attachment',
            'mimeType': part.get_content_type(),
            'size': len(payload),
            'contentId': content_id,
            'inline': inline,
            # Inline images are small and needed to show the email, so they come
            # with it; other attachments are fetched only when downloaded.
            **({'data': base64.b64encode(payload).decode('ascii')} if inline else {}),
        })

    def content(part):
        try:
            return part.get_content() if part is not None else None
        except (LookupError, UnicodeDecodeError):
            return (part.get_payload(decode=True) or b'').decode('utf-8', 'replace')

    return {
        'id': mid,
        'subject': decode_header(msg.get('Subject')),
        'from': address(str(msg.get('From', ''))),
        'to': addresses(msg.get_all('To')),
        'cc': addresses(msg.get_all('Cc')),
        'bcc': addresses(msg.get_all('Bcc')),
        'replyTo': addresses(msg.get_all('Reply-To')),
        'internetMessageId': (msg.get('Message-ID') or '').strip() or None,
        'inReplyTo': (msg.get('In-Reply-To') or '').strip() or None,
        'references': ' '.join((msg.get('References') or '').split()) or None,
        'date': date_ms(msg.get('Date')) or 0,
        'isRead': '\\Seen' in meta,
        'html': content(html_part),
        'text': content(text_part),
        'attachments': attachments,
    }


def _addr_list(values):
    return ['{} <{}>'.format(n, a) if n else a for n, a in email.utils.getaddresses([str(v) for v in values or []])]


def addresses(values):
    """Address objects from raw header values; names are decoded after
    splitting, so a comma inside a quoted name stays in the name."""
    return [{'name': decode_header(n), 'email': a}
            for n, a in email.utils.getaddresses([str(v) for v in values or []]) if a]


def _fetch_section(conn, uid, section):
    """One MIME part, decoded; None if the server's answer is unusable."""
    typ, data = conn.uid('FETCH', uid, '(BODY.PEEK[{0}.MIME] BODY.PEEK[{0}])'.format(section))
    if typ != 'OK':
        return None
    mime_hdr, body = None, None
    for item in data:
        if isinstance(item, tuple):
            meta = _text(item[0])
            if '{}.MIME]'.format(section) in meta:
                mime_hdr = item[1]
            elif 'BODY[{}]'.format(section) in meta:
                body = item[1]
    if body is None:
        return None
    cte = ''
    if mime_hdr:
        cte = (email.message_from_bytes(mime_hdr).get('Content-Transfer-Encoding') or '').strip().lower()
    if cte == 'base64':
        return base64.b64decode(body, validate=False)
    if cte == 'quoted-printable':
        import quopri
        return quopri.decodestring(body)
    return body


def cmd_get_attachment(req):
    conn = connect(req['provider'], req['email'])
    try:
        uidvalidity = open_folder(conn, req, readonly=True)
        (uid,) = parse_ids([req['id']], uidvalidity)
        # Fast path: fetch just this part. It is trusted only if its size
        # matches what the full email said; otherwise fetch the whole email.
        section = req.get('section')
        if section and re.fullmatch(r'\d+(\.\d+)*', str(section)):
            payload = _fetch_section(conn, uid, section)
            if payload is not None and (req.get('size') is None or len(payload) == int(req['size'])):
                return {'data': base64.b64encode(payload).decode('ascii')}
        _, raw = fetch_raw(conn, uid)
    finally:
        _logout(conn)
    parts = leaf_parts(email.message_from_bytes(raw, policy=email.policy.default))
    index = int(req['attachmentId'])
    if index >= len(parts):
        raise HelperError('not_found', 'Attachment not found')
    payload = parts[index].get_payload(decode=True) or b''
    return {'data': base64.b64encode(payload).decode('ascii')}


def store_seen(conn, uids, seen, total=None, offset=0):
    op = '+FLAGS.SILENT' if seen else '-FLAGS.SILENT'
    for i in range(0, len(uids), STORE_BATCH):
        batch = uids[i:i + STORE_BATCH]
        typ, data = conn.uid('STORE', ','.join(str(u) for u in batch), op, '(\\Seen)')
        check(typ, data, 'Updating read status')
        if total:
            progress(offset + i + len(batch), total)


def cmd_set_read(req):
    conn = connect(req['provider'], req['email'])
    try:
        uidvalidity = open_folder(conn, req, readonly=False)
        uids = parse_ids(req['ids'], uidvalidity)
        store_seen(conn, uids, bool(req.get('read', True)))
        return {'failed': []}
    finally:
        _logout(conn)


def cmd_mark_all_read(req):
    conn = connect(req['provider'], req['email'])
    try:
        select_inbox(conn, readonly=False)
        uids = unseen_uids(conn)
        progress(0, len(uids))
        store_seen(conn, uids, True, total=len(uids))
        return {'total': len(uids), 'failed': []}
    finally:
        _logout(conn)


TRASH_NAMES = ('Deleted Messages', 'Trash', 'Deleted Items', 'Deleted')
# Yahoo and AOL call it "Bulk" / "Bulk Mail"; iCloud "Junk".
JUNK_NAMES = ('Junk', 'Spam', 'Bulk', 'Bulk Mail', 'Junk E-mail', 'Junk Email')


def find_special(conn, flag, wanted_names, what):
    """The folder with the special-use flag (RFC 6154), else a well-known name."""
    typ, data = conn.list()
    check(typ, data, 'Listing folders')
    names = []
    for line in data:
        line = _text(line)
        m = re.match(r'\((?P<flags>[^)]*)\) (?:"[^"]*"|NIL) (?P<name>.+)$', line)
        if not m:
            continue
        name = m.group('name').strip()
        if name.startswith('"') and name.endswith('"'):
            name = name[1:-1].replace('\\"', '"').replace('\\\\', '\\')
        if flag in m.group('flags').lower():
            return name
        names.append(name)
    for wanted in wanted_names:
        for name in names:
            if name.lower() == wanted.lower():
                return name
    raise HelperError('imap', 'Could not find the {} folder'.format(what))


def find_trash(conn):
    return find_special(conn, '\\trash', TRASH_NAMES, 'Trash')


def find_junk(conn):
    return find_special(conn, '\\junk', JUNK_NAMES, 'Spam')


SENT_NAMES = ('Sent Messages', 'Sent', 'Sent Items', 'Sent Mail')
DRAFTS_NAMES = ('Drafts', 'Draft')


def find_sent(conn):
    return find_special(conn, '\\sent', SENT_NAMES, 'Sent')


def find_drafts(conn):
    return find_special(conn, '\\drafts', DRAFTS_NAMES, 'Drafts')


FINDERS = {'spam': find_junk, 'sent': find_sent, 'drafts': find_drafts}


def quote_mailbox(name):
    return '"' + name.replace('\\', '\\\\').replace('"', '\\"') + '"'


def move_uids(conn, uids, dest, what):
    """Moves messages of the selected folder to dest (MOVE, else COPY + delete)."""
    uids = ','.join(uids)
    # Servers advertise MOVE/UIDPLUS only after login, so ask again.
    typ, data = conn.capability()
    caps = set(_text(data[0]).upper().split()) if typ == 'OK' and data else set()
    target = dest if dest == 'INBOX' else quote_mailbox(dest)
    if 'MOVE' in caps:
        typ, data = conn.uid('MOVE', uids, target)
        check(typ, data, 'Moving to {}'.format(what))
    else:
        typ, data = conn.uid('COPY', uids, target)
        check(typ, data, 'Copying to {}'.format(what))
        typ, data = conn.uid('STORE', uids, '+FLAGS.SILENT', '(\\Deleted)')
        check(typ, data, 'Removing the original')
        # UID EXPUNGE only removes these messages, never others that happen
        # to be flagged \Deleted.
        if 'UIDPLUS' in caps:
            conn.uid('EXPUNGE', uids)


def cmd_trash(req):
    conn = connect(req['provider'], req['email'])
    try:
        trash = find_trash(conn)
        uidvalidity = open_folder(conn, req, readonly=False)
        move_uids(conn, parse_ids(req['ids'], uidvalidity), trash, 'Trash')
        return {'trash': trash, 'failed': []}
    finally:
        _logout(conn)


def cmd_spam_list(req):
    """The newest unread emails in the spam folder."""
    limit = int(req.get('limit', 20))
    conn = connect(req['provider'], req['email'])
    try:
        uidvalidity = select_folder(conn, find_junk(conn), readonly=True)
        uids = search(conn, 'UNSEEN')
        return {'messages': fetch_headers(conn, sorted(uids)[-limit:], uidvalidity)}
    finally:
        _logout(conn)


def cmd_not_spam(req):
    """Moves emails from the spam folder back to the inbox."""
    conn = connect(req['provider'], req['email'])
    try:
        uidvalidity = select_folder(conn, find_junk(conn), readonly=False)
        move_uids(conn, parse_ids(req['ids'], uidvalidity), 'INBOX', 'Inbox')
        return {'failed': []}
    finally:
        _logout(conn)


def spam_unread(conn):
    """Unread count of the spam folder, or None if there is none."""
    try:
        junk = find_junk(conn)
    except HelperError:
        return None
    typ, data = conn.status(quote_mailbox(junk), '(UNSEEN)')
    m = re.search(r'UNSEEN (\d+)', _text(data[0] or b'')) if typ == 'OK' and data else None
    return int(m.group(1)) if m else None


def cmd_save_account(req):
    """Checks the password by logging in, then stores it in Keychain."""
    conn = connect(req['provider'], req['email'], password=req['password'])
    _logout(conn)
    set_password(key(req['provider'], req['email']), req['password'])
    return {'email': req['email']}


def cmd_remove_account(req):
    delete_password(key(req['provider'], req['email']))
    return {}


def _logout(conn):
    try:
        conn.logout()
    except Exception:
        pass


# ---------- push: IMAP IDLE (RFC 2177) ----------
#
# In watch mode Chrome keeps the helper running through an open port. One
# thread per account keeps a read-only IDLE connection to the INBOX and reports
# {"event": "changed"} when the server announces new, removed or re-flagged
# mail; the extension then refreshes that account. Nothing is downloaded here.

IDLE_RENEW_S = 25 * 60  # servers may drop IDLE after 30 minutes
CHANGE_RE = re.compile(rb'^\* \d+ (EXISTS|EXPUNGE|FETCH)\b', re.I)


class Watcher(threading.Thread):
    def __init__(self, provider, email_addr):
        super().__init__(daemon=True)
        self.provider = provider
        self.email = email_addr
        self.stopped = threading.Event()
        self.sock = None

    def emit(self, event, **extra):
        if self.stopped.is_set():
            return
        send({'event': event, 'provider': self.provider, 'email': self.email, **extra})

    def stop(self):
        self.stopped.set()
        sock = self.sock
        if sock:
            # shutdown() wakes a recv() blocked in the watcher thread; close()
            # alone does not reliably do so.
            for fn in (lambda: sock.shutdown(socket.SHUT_RDWR), sock.close):
                try:
                    fn()
                except OSError:
                    pass

    def run(self):
        backoff = 5
        first = True
        while not self.stopped.is_set():
            try:
                self.cycle(resync=not first)
                backoff = 5
                first = True  # a clean renewal needs no resync
            except HelperError as e:
                if self.stopped.is_set():
                    return
                if e.code == 'no_idle':
                    self.emit('status', state='unsupported', message=str(e))
                    return
                self.emit('status', state='error', message=str(e))
                self.stopped.wait(300 if e.code == 'auth' else backoff)
                backoff = min(backoff * 2, 300)
                first = False
            except Exception as e:
                if self.stopped.is_set():
                    return
                self.emit('status', state='reconnecting', message='{}: {}'.format(type(e).__name__, e))
                self.stopped.wait(backoff)
                backoff = min(backoff * 2, 300)
                first = False

    def cycle(self, resync):
        conn = connect(self.provider, self.email)
        try:
            typ, data = conn.capability()
            caps = set(_text(data[0]).upper().split()) if typ == 'OK' and data else set()
            if 'IDLE' not in caps:
                raise HelperError('no_idle', 'This server does not support push (IDLE)')
            select_inbox(conn, readonly=True)
            # From here the raw TLS socket is read directly, with timeouts, so
            # stopping and renewing stay responsive (imaplib has no IDLE before
            # Python 3.14).
            self.sock = conn.sock
            tag = conn._new_tag()
            self.sock.sendall(tag + b' IDLE\r\n')
            self.sock.settimeout(60)
            buf = b''
            idling = False
            started = time.monotonic()
            if resync:
                self.emit('changed')  # catch up on anything missed while disconnected
            while not self.stopped.is_set() and time.monotonic() - started < IDLE_RENEW_S:
                try:
                    chunk = self.sock.recv(65536)
                except (socket.timeout, TimeoutError):
                    continue
                if not chunk:
                    raise OSError('the server closed the connection')
                buf += chunk
                changed = False
                while b'\r\n' in buf:
                    line, buf = buf.split(b'\r\n', 1)
                    if line.startswith(b'+') and not idling:
                        idling = True
                        self.emit('status', state='idle')
                    elif line.startswith(tag):
                        raise HelperError('imap', 'IDLE was refused: ' + _text(line))
                    elif line.upper().startswith(b'* BYE'):
                        raise OSError('the server ended the session')
                    elif CHANGE_RE.match(line):
                        changed = True
                if changed and not self.stopped.is_set():
                    self.emit('changed')
            try:
                self.sock.sendall(b'DONE\r\n' + conn._new_tag() + b' LOGOUT\r\n')
            except OSError:
                pass
        finally:
            try:
                conn.sock.close()
            except OSError:
                pass
            self.sock = None


def watch_loop(first_request):
    watchers = {}

    def apply(accounts):
        wanted = {}
        for a in accounts or []:
            if a.get('provider') in SERVERS or os.environ.get('UNREAD_MAIL_IMAP_OVERRIDE'):
                wanted[key(a['provider'], a['email'])] = (a['provider'], a['email'])
        for k in list(watchers):
            if k not in wanted:
                watchers.pop(k).stop()
        for k, (provider, email_addr) in wanted.items():
            if k not in watchers:
                w = Watcher(provider, email_addr)
                watchers[k] = w
                w.start()

    apply(first_request.get('accounts'))
    send({'event': 'ready', 'version': VERSION})
    while True:
        req = read_message()
        if req is None:  # Chrome closed the port
            os._exit(0)
        if req.get('cmd') == 'watch':
            apply(req.get('accounts'))


# ---------- Sent, Drafts and sending ----------

def cmd_folder_list(req):
    """The newest emails of a folder ("sent", "drafts", "spam"); unseenOnly
    limits it to unread ones."""
    limit = int(req.get('limit', 10))
    conn = connect(req['provider'], req['email'])
    try:
        uidvalidity = open_folder(conn, req, readonly=True)
        uids = search(conn, 'UNSEEN' if req.get('unseenOnly') else 'ALL')
        return {'messages': fetch_headers(conn, sorted(uids)[-limit:], uidvalidity)}
    finally:
        _logout(conn)


def _append(conn, mailbox, raw, flags):
    typ, data = conn.append(quote_mailbox(mailbox), flags, imaplib.Time2Internaldate(time.time()), raw)
    check(typ, data, 'Saving to {}'.format(mailbox))


def _find_by_message_id(conn, message_id):
    typ, data = conn.uid('SEARCH', None, 'HEADER', 'Message-ID', '"{}"'.format(message_id.replace('"', '')))
    uids = [int(u) for u in _text(data[0] or b'').split()] if typ == 'OK' else []
    return max(uids) if uids else None


def _expunge_uids(conn, uids):
    typ, data = conn.uid('STORE', ','.join(uids), '+FLAGS.SILENT', '(\\Deleted)')
    check(typ, data, 'Removing the old draft')
    typ, data = conn.capability()
    caps = set(_text(data[0]).upper().split()) if typ == 'OK' and data else set()
    if 'UIDPLUS' in caps:
        conn.uid('EXPUNGE', ','.join(uids))
    else:
        conn.expunge()


def cmd_save_draft(req):
    """Saves a draft (a full MIME message) to Drafts, replacing the previous
    version if replaceId is given. Returns the new id."""
    raw = base64.b64decode(req['raw'])
    conn = connect(req['provider'], req['email'])
    try:
        drafts = find_drafts(conn)
        _append(conn, drafts, raw, '(\\Draft \\Seen)')
        uidvalidity = select_folder(conn, drafts, readonly=False)
        uid = _find_by_message_id(conn, req['messageId'])
        old = [u for u in parse_ids([req['replaceId']], uidvalidity)] if req.get('replaceId') else []
        old = [u for u in old if str(u) != str(uid)]
        if old:
            _expunge_uids(conn, old)
        if uid is None:
            raise HelperError('imap', 'The draft was saved but could not be found again')
        return {'id': '{}-{}'.format(uidvalidity, uid)}
    except HelperError as e:
        if e.code == 'stale':  # Drafts was rebuilt; the old copy is gone anyway
            return {'id': None}
        raise
    finally:
        _logout(conn)


def cmd_delete_draft(req):
    conn = connect(req['provider'], req['email'])
    try:
        uidvalidity = select_folder(conn, find_drafts(conn), readonly=False)
        _expunge_uids(conn, parse_ids([req['id']], uidvalidity))
        return {}
    finally:
        _logout(conn)


def smtp_server(provider):
    # Development override: UNREAD_MAIL_SMTP_OVERRIDE=host:port[:plain]
    override = os.environ.get('UNREAD_MAIL_SMTP_OVERRIDE')
    if override:
        parts = override.split(':')
        return parts[0], int(parts[1]), None
    if provider not in SMTP_SERVERS:
        raise HelperError('bad_request', 'Unknown provider: ' + str(provider))
    return SMTP_SERVERS[provider]


def cmd_send(req):
    """Sends a MIME message over SMTP with the saved app password, then
    removes its draft and (for iCloud) files a copy in Sent."""
    raw = base64.b64decode(req['raw'])  # without a Bcc header
    rcpts = [r for r in req.get('rcpts', []) if r]
    if not rcpts:
        raise HelperError('bad_request', 'No recipients')
    provider, email_addr = req['provider'], req['email']
    password = get_password(key(provider, email_addr))
    host, port, implicit_tls = smtp_server(provider)
    try:
        if implicit_tls is None:  # test server, no TLS
            smtp = smtplib.SMTP(host, port, timeout=60)
        elif implicit_tls:
            smtp = smtplib.SMTP_SSL(host, port, context=tls_context(), timeout=60)
        else:
            smtp = smtplib.SMTP(host, port, timeout=60)
            smtp.starttls(context=tls_context())
        with smtp:
            if implicit_tls is not None:
                smtp.login(email_addr, password)
            refused = smtp.sendmail(email_addr, rcpts, raw)
    except smtplib.SMTPAuthenticationError:
        raise HelperError('auth', 'The mail server rejected the app password for sending')
    except smtplib.SMTPRecipientsRefused as e:
        raise HelperError('rejected', 'No recipient was accepted: ' + ', '.join(e.recipients))
    except (smtplib.SMTPException, OSError) as e:
        raise HelperError('network', 'Sending failed: {}'.format(e))

    # Housekeeping; the email is already sent, so problems here are reported
    # but do not fail the send.
    warning = None
    try:
        conn = connect(provider, email_addr, password)
        try:
            if req.get('draftId'):
                try:
                    uidvalidity = select_folder(conn, find_drafts(conn), readonly=False)
                    _expunge_uids(conn, parse_ids([req['draftId']], uidvalidity))
                except HelperError:
                    pass
            if provider not in SAVES_SENT_ITSELF or req.get('saveSent'):
                _append(conn, find_sent(conn), raw, '(\\Seen)')
        finally:
            _logout(conn)
    except (HelperError, imaplib.IMAP4.error, OSError) as e:
        warning = 'Sent, but tidying up Drafts/Sent failed: {}'.format(e)
    return {'refused': sorted(refused.keys()) if refused else [], 'warning': warning}


# ---------- one-click update of the extension ----------
#
# An unpacked extension cannot change its own files, so the "Install update"
# button asks the helper to. install.sh records the extension folder in
# install.json next to this file. The ZIP comes only from this repository's
# branch over HTTPS; it must carry the same extension key (so it is the same
# extension) before anything is written. src/config.js is kept, as by
# the installer. Accounts and settings are in Chrome's storage, not in the folder.

UPDATE_REPO = 'rycpot/Unread-Mail_File-Hosting'
UPDATE_BRANCH = 'claude/blissful-faraday-8ykg9h'
UPDATE_KEEP = {'src/config.js'}
UPDATE_MAX_BYTES = 50 * 1024 * 1024


def _install_info():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'install.json')
    try:
        with open(path) as f:
            info = json.load(f)
    except (OSError, ValueError):
        info = {}
    ext = info.get('extensionDir')
    ext = ext and os.path.realpath(ext)  # write to the real folder, not a link to it
    if not ext or not os.path.isfile(os.path.join(ext, 'manifest.json')):
        raise HelperError('not_configured', 'Run the install command from the README once in Terminal to enable one-click updates.')
    return ext


def _download_update():
    # Tests point this at a local file:// ZIP.
    url = os.environ.get('UNREAD_MAIL_UPDATE_URL') or \
        'https://codeload.github.com/{}/zip/refs/heads/{}'.format(UPDATE_REPO, UPDATE_BRANCH)
    with urllib.request.urlopen(url, context=tls_context(), timeout=60) as res:
        data = res.read(UPDATE_MAX_BYTES + 1)
    if len(data) > UPDATE_MAX_BYTES:
        raise HelperError('update', 'The update download is unexpectedly large; not installed.')
    return data


def cmd_self_update(req):
    ext = _install_info()
    try:
        return _self_update(ext)
    except PermissionError:
        raise HelperError('permission', "macOS doesn't let the helper change files in {}. Run the install command from "
                          'the README once: it moves the folder to ~/UnreadMail, which is allowed.'.format(ext))


def _self_update(ext):
    with open(os.path.join(ext, 'manifest.json')) as f:
        current = json.load(f)
    try:
        archive = zipfile.ZipFile(io.BytesIO(_download_update()))
    except zipfile.BadZipFile:
        raise HelperError('update', 'The update download was not a valid ZIP file.')
    files = [i for i in archive.infolist() if not i.is_dir()]
    prefix = files[0].filename.split('/', 1)[0] + '/' if files else ''
    try:
        new = json.loads(archive.read(prefix + 'manifest.json'))
    except (KeyError, ValueError):
        raise HelperError('update', 'The download has no valid manifest.json; not installed.')
    if new.get('key') != current.get('key'):
        raise HelperError('update', 'The download is a different extension (key mismatch); not installed.')

    for n, info in enumerate(files, 1):
        if not info.filename.startswith(prefix):
            continue
        rel = info.filename[len(prefix):]
        parts = rel.split('/')
        if not rel or rel.startswith('/') or '..' in parts or '\\' in rel:
            continue  # never write outside the extension folder
        dest = os.path.join(ext, *parts)
        if rel in UPDATE_KEEP and os.path.exists(dest):
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = dest + '.updating'
        with open(tmp, 'wb') as f:
            f.write(archive.read(info))
        if (info.external_attr >> 16) & 0o111:
            os.chmod(tmp, 0o755)
        os.replace(tmp, dest)
        if n % 20 == 0:
            progress(n, len(files))

    # Refresh the installed helper and Chrome's registration of it.
    warning = None
    res = subprocess.run(['/bin/sh', os.path.join(ext, 'helper', 'install.sh')],
                         capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        warning = 'Updated, but refreshing the helper failed; run the install command from the README. {}'.format(res.stderr.strip()[-300:])
    return {'version': new.get('version'), 'helperWarning': warning}


COMMANDS = {
    'ping': lambda req: {'version': VERSION, 'platform': sys.platform,
                         'caCerts': tls_context().cert_store_stats().get('x509_ca', 0)},
    'saveAccount': cmd_save_account,
    'removeAccount': cmd_remove_account,
    'summary': cmd_summary,
    'recentRead': cmd_recent_read,
    'getMessage': cmd_get_message,
    'getMessages': cmd_get_messages,
    'getAttachments': cmd_get_attachments,
    'getAttachment': cmd_get_attachment,
    'setRead': cmd_set_read,
    'markAllRead': cmd_mark_all_read,
    'trash': cmd_trash,
    'spamList': cmd_spam_list,
    'folderList': cmd_folder_list,
    'saveDraft': cmd_save_draft,
    'deleteDraft': cmd_delete_draft,
    'send': cmd_send,
    'notSpam': cmd_not_spam,
    'selfUpdate': cmd_self_update,
}

# imaplib.uid() only accepts commands it knows; EXPUNGE via UID needs UIDPLUS.
imaplib.Commands.setdefault('EXPUNGE', ('SELECTED',))


def main():
    try:
        req = read_message()
        if req is None:
            return
        if req.get('cmd') == 'watch':
            watch_loop(req)
            return
        handler = COMMANDS.get(req.get('cmd'))
        if not handler:
            raise HelperError('bad_request', 'Unknown command: {}'.format(req.get('cmd')))
        reply(handler(req))
    except HelperError as e:
        send({'done': True, 'error': {'code': e.code, 'message': str(e)}})
    except (imaplib.IMAP4.abort, OSError, TimeoutError) as e:
        send({'done': True, 'error': {'code': 'network', 'message': 'Connection problem: {}'.format(e)}})
    except Exception as e:  # never leave Chrome waiting without a reply
        send({'done': True, 'error': {'code': 'internal', 'message': '{}: {}'.format(type(e).__name__, e)}})


if __name__ == '__main__':
    main()
