"""Python 3.10+ example: submit/query tasks and durably receive callbacks.

Only standard-library modules are needed. See docs/usage.md.
This receiver stores results; it does not run downstream business side effects.
"""
import argparse
from contextlib import closing
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

PROJECT_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")
CONVERSATION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
CHAT_ID = CONVERSATION_ID
CALLBACK_LIMIT = 2 * 1024 * 1024  # result plus the metadata envelope


def token(name):
    value = os.environ.get(name, "")
    if not value:
        return None
    if any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise ValueError(f"Use a token without whitespace in {name}, or leave it unset")
    # Use ASCII tokens so HTTP header encoding is unambiguous.
    value.encode("ascii")
    return value


def reject_constant(value):
    raise ValueError(f"Not a JSON number: {value}")


def parse_json(data):
    return json.loads(data, parse_constant=reject_constant)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_bridge(method, path, payload=None):
    base = os.environ.get("DSH_API_BASE", "http://127.0.0.1:3080/api/terms-bridge").rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("DSH_API_BASE must be an HTTP(S) API prefix URL without credentials/query/fragment")
    headers = {"Content-Type": "application/json"}
    request_token = token("DSH_REQUEST_TOKEN")
    if request_token:
        headers["Authorization"] = "Bearer " + request_token
    data = canonical(payload).encode("utf-8") if payload is not None else None
    req = Request(base + path, data=data, headers=headers, method=method)
    try:
        with build_opener(NoRedirect()).open(req, timeout=20) as response:
            status, raw = response.status, response.read()
            if response.headers.get("Location"):
                print("Location:", response.headers["Location"])
    except HTTPError as error:
        status, raw = error.code, error.read()
    except (URLError, TimeoutError) as error:
        print(f"Request outcome is uncertain ({type(error).__name__}). Query the saved IDs first; resubmission of an accepted chat returns 409. Omitted IDs cannot be recovered from a lost response.", file=sys.stderr)
        return 1
    print("HTTP", status)
    try:
        print(json.dumps(parse_json(raw.decode("utf-8")), ensure_ascii=False, indent=2))
    except (ValueError, UnicodeError):
        print("Non-JSON response: check the dsh/reverse-proxy authentication and API route.")
        return 1
    return 0 if 200 <= status < 300 else 1


def make_receiver(database, project_id, callback_headers):
    if not isinstance(callback_headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in callback_headers.items()):
        raise ValueError('DSH_CALLBACK_HEADERS must be a JSON object with string values')
    database = str(Path(database).resolve())
    Path(database).parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(database)) as db, db:
        db.execute("PRAGMA synchronous=FULL")
        db.execute("""CREATE TABLE IF NOT EXISTS received_results_v3 (
            project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, chat_id TEXT NOT NULL, payload_json TEXT NOT NULL,
            received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            PRIMARY KEY (project_id, conversation_id, chat_id)
        )""")

    class Receiver(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *args):
            pass  # Avoid logging authorization headers or business content.

        def reply(self, status):
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            if self.path != "/api/dsh/results":
                self.reply(404)
                return
            for name, value in callback_headers.items():
                received = self.headers.get_all(name, [])
                if len(received) != 1 or not hmac.compare_digest(received[0].encode('utf-8'), value.encode('utf-8')):
                    self.reply(401)
                    return
            if self.headers.get("X-DSH-Protocol-Version") != "3":
                self.reply(400)
                return
            if self.headers.get_content_type() != "application/json":
                self.reply(415)
                return
            if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Encoding", "identity") != "identity":
                self.reply(415)
                return
            try:
                length = int(self.headers.get("Content-Length", "-1"))
                if length < 0:
                    self.reply(411)
                    return
                if length > CALLBACK_LIMIT:
                    self.reply(413)
                    return
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("Incomplete body")
                body = parse_json(raw.decode("utf-8"))
                if not isinstance(body, dict) or set(body) != {"metadata", "result", "files"}:
                    raise ValueError("Invalid callback envelope")
                metadata = body["metadata"]
                if not isinstance(metadata, dict) or set(metadata) != {"project_id", "conversation_id", "chat_id"}:
                    raise ValueError("Invalid metadata")
                if metadata.get("project_id") != project_id:
                    self.reply(403)
                    return
                conversation_id, chat_id = metadata["conversation_id"], metadata["chat_id"]
                if not isinstance(conversation_id, str) or not CONVERSATION_ID.fullmatch(conversation_id):
                    raise ValueError("Invalid conversation ID")
                if not isinstance(chat_id, str) or not CHAT_ID.fullmatch(chat_id):
                    raise ValueError("Invalid chat ID")
                if not isinstance(body["result"], str) or not isinstance(body["files"], list):
                    raise ValueError("Invalid result or files")
                payload = canonical(body)
            except (ValueError, UnicodeError, RecursionError):
                self.reply(400)
                return
            except TimeoutError:
                self.reply(408)
                return
            try:
                # A transaction plus the primary key handles concurrent duplicates.
                with closing(sqlite3.connect(database, timeout=5)) as db, db:
                    db.execute("PRAGMA synchronous=FULL")
                    db.execute("BEGIN IMMEDIATE")
                    old = db.execute("SELECT payload_json FROM received_results_v3 WHERE project_id=? AND conversation_id=? AND chat_id=?", (project_id, conversation_id, chat_id)).fetchone()
                    if old is not None and old[0] != payload:
                        self.reply(409)  # Never overwrite a committed result.
                        return
                    if old is None:
                        db.execute("INSERT INTO received_results_v3(project_id,conversation_id,chat_id,payload_json) VALUES (?,?,?,?)", (project_id, conversation_id, chat_id, payload))
                # The transaction is committed before acknowledging delivery.
            except sqlite3.Error:
                self.reply(503)
                return
            self.reply(204)

    return Receiver


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    submit = commands.add_parser("submit")
    submit.add_argument("file", help="Saved task JSON; an already accepted chat returns 409")
    query = commands.add_parser("query")
    query.add_argument("project_id")
    query.add_argument("conversation_id")
    query.add_argument("chat_id")
    serve = commands.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8081)
    serve.add_argument("--project-id", default="news")
    serve.add_argument("--db", default="./callback-results.sqlite3")
    args = parser.parse_args()
    if args.command == "submit":
        return request_bridge("POST", "/tasks", parse_json(Path(args.file).read_text(encoding="utf-8-sig")))
    if not PROJECT_ID.fullmatch(args.project_id):
        raise ValueError("Invalid project_id")
    if args.command == "query":
        if not CONVERSATION_ID.fullmatch(args.conversation_id) or not CHAT_ID.fullmatch(args.chat_id):
            raise ValueError("Invalid conversation_id or chat_id")
        return request_bridge("GET", f"/projects/{quote(args.project_id, safe='')}/conversations/{quote(args.conversation_id, safe='')}/chats/{quote(args.chat_id, safe='')}")
    receiver = make_receiver(args.db, args.project_id, parse_json(os.environ.get("DSH_CALLBACK_HEADERS", "{}")))
    server = ThreadingHTTPServer((args.host, args.port), receiver)
    print(f"Callback receiver: http://{args.host}:{server.server_port}/api/dsh/results", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
