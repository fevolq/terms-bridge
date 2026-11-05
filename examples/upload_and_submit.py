"""Upload project files, save an immutable task JSON, and submit it (Python 3.10+, stdlib).

Use project_client.py query with the saved IDs if the task response is lost.
Uploads are scoped only to project_id; returned file_id values can be reused.
"""
import argparse
import http.client
import json
import mimetypes
import os
from pathlib import Path
import sys
from urllib.parse import quote, urlsplit
from uuid import uuid4

from project_client import PROJECT_ID, CONVERSATION_ID, CHAT_ID, canonical, request_bridge, token


def upload_file(project_id, path):
    path = Path(path)
    if not PROJECT_ID.fullmatch(project_id):
        raise ValueError("Invalid project_id")
    size = path.stat().st_size
    if not path.is_file() or size > 50 * 1024 * 1024:
        raise ValueError("Each file must be a regular file of at most 50 MiB")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in path.name):
        raise ValueError("Control characters are not supported in filenames")
    base = urlsplit(os.environ.get("DSH_API_BASE", "http://127.0.0.1:3080/api/terms-bridge").rstrip("/"))
    if base.scheme not in ("http", "https") or not base.netloc or base.username or base.password or base.query or base.fragment:
        raise ValueError("DSH_API_BASE must be an HTTP(S) API prefix URL without credentials/query/fragment")
    boundary = "dsh-" + uuid4().hex
    filename = path.name.replace("\\", "\\\\").replace('"', '\\"')
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
              f"Content-Type: {media_type}\r\n\r\n").encode("utf-8")
    suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
    cls = http.client.HTTPSConnection if base.scheme == "https" else http.client.HTTPConnection
    connection = cls(base.hostname, base.port, timeout=120)
    try:
        connection.putrequest("POST", base.path + f"/projects/{quote(project_id, safe='')}/files")
        connection.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        connection.putheader("Content-Length", str(len(prefix) + size + len(suffix)))
        secret = token("DSH_REQUEST_TOKEN")
        if secret:
            connection.putheader("Authorization", "Bearer " + secret)
        connection.endheaders()
        connection.send(prefix)
        with path.open("rb") as source:
            while chunk := source.read(65536):
                connection.send(chunk)
        connection.send(suffix)
        response = connection.getresponse()
        raw = response.read(65537)
        if response.status != 201:
            raise ValueError(f"Upload HTTP {response.status}: {raw[:2048].decode('utf-8', errors='replace')}")
        if len(raw) > 65536:
            raise ValueError("Unexpected upload response size")
        file = json.loads(raw)
        if file.get("project_id") != project_id or not isinstance(file.get("file_id"), str):
            raise ValueError("Unexpected upload response")
        return file
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_id")
    parser.add_argument("files", nargs="+")
    parser.add_argument("--conversation-id", default=None, help="Existing or new conversation; generated if omitted")
    parser.add_argument("--chat-id", default=None, help="New chat ID; generated if omitted")
    parser.add_argument("--instruction", required=True, help="Complete dsh user prompt")
    parser.add_argument("--out", required=True, help="New task JSON path; never overwrite an earlier submission")
    args = parser.parse_args()
    conversation_id = args.conversation_id if args.conversation_id is not None else str(uuid4())
    chat_id = args.chat_id if args.chat_id is not None else str(uuid4())
    if not PROJECT_ID.fullmatch(args.project_id) or not CONVERSATION_ID.fullmatch(conversation_id) or not CHAT_ID.fullmatch(chat_id):
        raise ValueError("Invalid project_id, conversation_id or chat_id")
    output = Path(args.out)
    if output.exists():
        raise ValueError("Task JSON already exists. Query its saved IDs before resubmitting; accepted chats return 409.")
    paths = [Path(name) for name in args.files]
    if len(paths) > 20 or any(not p.is_file() or p.stat().st_size > 50 * 1024 * 1024 for p in paths) or sum(p.stat().st_size for p in paths) > 200 * 1024 * 1024:
        raise ValueError("Use 1-20 regular files, at most 50 MiB each and 200 MiB total")
    files = [upload_file(args.project_id, p) for p in paths]
    task = {
        "metadata": {"project_id": args.project_id, "conversation_id": conversation_id, "chat_id": chat_id},
        "instruction": args.instruction,
        "files": [{"file_id": file["file_id"]} for file in files],
    }
    # Save IDs before submitting: a lost task response must not trigger another upload.
    with output.open("x", encoding="utf-8") as saved:
        saved.write(canonical(task) + "\n")
    print(f"Saved task JSON: {output}")
    return request_bridge("POST", "/tasks", task)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, http.client.HTTPException) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
