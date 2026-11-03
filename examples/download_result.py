"""Download a registered project file and verify its SHA-256 (Python 3.10+, stdlib)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener

from project_client import NoRedirect, PROJECT_ID, token


def download_file(project_id, file_id, output, expected_sha256=None):
    if not PROJECT_ID.fullmatch(project_id) or not re.fullmatch(r"file_[a-f0-9]{32}", file_id):
        raise ValueError("Invalid project_id or file_id")
    if expected_sha256 is not None and not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise ValueError("Expected SHA-256 must be 64 lowercase hexadecimal characters")
    base = os.environ.get("DSH_API_BASE", "http://127.0.0.1:3080/api/terms-bridge").rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("DSH_API_BASE must be an HTTP(S) API prefix URL without credentials/query/fragment")
    headers = {}
    secret = token("DSH_REQUEST_TOKEN")
    if secret:
        headers["Authorization"] = "Bearer " + secret
    req = Request(f"{base}/projects/{quote(project_id, safe='')}/files/{file_id}", headers=headers)
    output = Path(output)
    created = False
    try:
        with build_opener(NoRedirect()).open(req, timeout=120) as response:
            if response.status != 200:
                raise ValueError(f"Download HTTP {response.status}")
            server_hash = response.headers.get("X-DSH-File-SHA256", "")
            if not re.fullmatch(r"[a-f0-9]{64}", server_hash):
                raise ValueError("Missing or invalid file checksum header")
            if expected_sha256 and server_hash != expected_sha256:
                raise ValueError("Server checksum differs from the callback")
            expected_size = int(response.headers.get("Content-Length", "-1"))
            if not 0 <= expected_size <= 50 * 1024 * 1024:
                raise ValueError("Unexpected file size")
            digest = hashlib.sha256()
            size = 0
            # The destination is chosen by the project, never by an untrusted remote filename.
            with output.open("xb") as saved:
                created = True
                while chunk := response.read(65536):
                    size += len(chunk)
                    if size > expected_size:
                        raise ValueError("Downloaded file exceeds its declared size")
                    digest.update(chunk)
                    saved.write(chunk)
                if size != expected_size or digest.hexdigest() != server_hash:
                    raise ValueError("File size or SHA-256 verification failed")
            return {"file_id": file_id, "path": str(output), "size": size, "sha256": digest.hexdigest()}
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_id")
    parser.add_argument("file_id")
    parser.add_argument("--out", required=True, help="New destination file; existing files are never overwritten")
    parser.add_argument("--sha256", help="Expected checksum from the result callback")
    args = parser.parse_args()
    print(json.dumps(download_file(args.project_id, args.file_id, args.out, args.sha256), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
