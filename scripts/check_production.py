"""Check the public PhotoWall health endpoint without mutating production state.

Usage:
    python3 scripts/check_production.py
    python3 scripts/check_production.py https://api.example.com
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_BASE_URL = "https://api.mokeedesign.cn"


def openssl_health_request(base_url: str) -> tuple[int, dict]:
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("OpenSSL fallback requires an HTTPS URL with a hostname")
    port = parsed.port or 443
    path = f"{parsed.path.rstrip('/')}/healthz" or "/healthz"
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {parsed.hostname}\r\n"
        "Accept: application/json\r\n"
        "Connection: close\r\n\r\n"
    )
    result = subprocess.run(
        ["openssl", "s_client", "-connect", f"{parsed.hostname}:{port}",
         "-servername", parsed.hostname, "-quiet"],
        input=request.encode(),
        capture_output=True,
        timeout=25,
        check=False,
    )
    head, separator, body = result.stdout.decode().partition("\r\n\r\n")
    if not separator:
        raise RuntimeError(result.stderr.decode().strip() or "OpenSSL did not return an HTTP response")
    status_line = head.splitlines()[0]
    _, status, _ = status_line.split(" ", 2)
    return int(status), json.loads(body)


def main() -> None:
    base_url = (sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BASE_URL).rstrip("/")
    request = urllib.request.Request(f"{base_url}/healthz", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status = response.status
            payload = json.loads(response.read())
    except urllib.error.URLError:
        try:
            status, payload = openssl_health_request(base_url)
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            raise SystemExit(f"Production health check failed: {error}") from error
    except json.JSONDecodeError as error:
        raise SystemExit(f"Production health check failed: {error}") from error

    if status != 200 or payload != {"status": "ok", "storage_ready": True}:
        raise SystemExit(f"Production health check failed: HTTP {status} {payload}")
    print(f"Production health check OK: {base_url}")


if __name__ == "__main__":
    main()