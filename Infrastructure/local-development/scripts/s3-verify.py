#!/usr/bin/env python3
"""s3-verify.py - local-dev S3 verification against SeaweedFS (dev credentials only).

Uses AWS SigV4 signing from Python stdlib only (no dependencies).
Credentials are LOCAL DEV values from .env / s3.config - never for production.

Usage: python s3-verify.py
Exit code 0 = all checks passed, 1 = failure.
"""
import hashlib
import hmac
import datetime
import os
import urllib.request
import urllib.error
import sys

# Credentials are read from the repo-root .env (git-ignored) - never hardcoded here.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def _load_env(name: str) -> str:
    env_path = os.path.join(_REPO_ROOT, ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get(name, "")


ACCESS_KEY = _load_env("S3_ACCESS_KEY")
SECRET_KEY = _load_env("S3_SECRET_KEY")
if not ACCESS_KEY or not SECRET_KEY:
    print("[S3] FAIL - S3_ACCESS_KEY / S3_SECRET_KEY missing from .env", file=sys.stderr)
    sys.exit(2)
HOST = "127.0.0.1:9000"
REGION = "us-east-1"
SERVICE = "s3"
BUCKET = "aicsp-files"
OBJECT_KEY = "dev/hello.txt"
PAYLOAD = b"local infrastructure verification object"


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def signed_request(method: str, path: str, query: str = "", payload: bytes = b""):
    t = datetime.datetime.now(datetime.timezone.utc)
    amzdate = t.strftime("%Y%m%dT%H%M%SZ")
    datestamp = t.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(payload).hexdigest()
    canonical_headers = (
        f"host:{HOST}\n"
        f"x-amz-content-sha256:{payload_hash}\n"
        f"x-amz-date:{amzdate}\n"
    )
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join(
        [method, path, query, canonical_headers, signed_headers, payload_hash]
    )
    scope = f"{datestamp}/{REGION}/{SERVICE}/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amzdate,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    key = _sign(("AWS4" + SECRET_KEY).encode("utf-8"), datestamp)
    key = _sign(key, REGION)
    key = _sign(key, SERVICE)
    key = _sign(key, "aws4_request")
    signature = hmac.new(key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    authorization = (
        f"AWS4-HMAC-SHA256 Credential={ACCESS_KEY}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    url = f"http://{HOST}{path}" + (f"?{query}" if query else "")
    req = urllib.request.Request(
        url, data=payload if method in ("POST", "PUT") else None, method=method
    )
    req.add_header("x-amz-date", amzdate)
    req.add_header("x-amz-content-sha256", payload_hash)
    req.add_header("Authorization", authorization)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # connection refused etc.
        return 0, str(e).encode()


def anonymous_get(path: str) -> int:
    try:
        with urllib.request.urlopen(f"http://{HOST}{path}", timeout=15) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def main() -> int:
    failures = 0

    def check(name: str, ok: bool, detail: str) -> None:
        nonlocal failures
        print(f"[S3] {name}: {'OK' if ok else 'FAIL'} - {detail}")
        if not ok:
            failures += 1

    # 1. Create bucket (200, or 409 if it already exists -> still usable)
    code, body = signed_request("PUT", f"/{BUCKET}")
    check(
        "PutBucket",
        code in (200, 204, 409),
        f"HTTP {code} {body[:120].decode('utf-8', 'replace')}",
    )

    # 2. ListBuckets
    code, body = signed_request("GET", "/")
    has_bucket = BUCKET.encode() in body
    check("ListBuckets", code == 200 and has_bucket, f"HTTP {code}, contains '{BUCKET}': {has_bucket}")

    # 3. PutObject
    code, body = signed_request("PUT", f"/{BUCKET}/{OBJECT_KEY}", payload=PAYLOAD)
    check("PutObject", code in (200, 204), f"HTTP {code}")

    # 4. GetObject round-trip
    code, body = signed_request("GET", f"/{BUCKET}/{OBJECT_KEY}")
    match = body == PAYLOAD
    check("GetObject", code == 200 and match, f"HTTP {code}, content matches: {match}")

    # 5. Anonymous access must be denied (auth is on)
    anon = anonymous_get(f"/{BUCKET}/{OBJECT_KEY}")
    check("AnonymousGetDenied", anon in (401, 403), f"HTTP {anon} (expected 401/403)")

    print(f"\n[S3] result: {'ALL CHECKS PASSED' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
