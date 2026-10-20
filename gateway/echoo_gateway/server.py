"""Local gateway harness. Production hosting/session verification is an external integration."""
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .contracts import ContractError, MAX_BODY_BYTES, canonical_json
from .providers import AliModerationProvider, QwenProvider
from .service import AnalysisService
from .blue_sky import BlueSkyService, BlueSkyQwenProvider
from .cutout_verification import CutoutVerificationService, QwenCutoutProvider


def make_handler(service, session_token, template_service=None, cutout_service=None):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, format, *args):
            # Default HTTP logs can include paths or request content. Use structured host telemetry later.
            pass

        def send_json(self, status, value):
            data = canonical_json(value)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, {"status": "ok", "mode": "local-development"})
            else:
                self.send_json(404, {"error": "not_found"})

        def do_POST(self):
            if self.path != "/v1/analyze" and not (self.path == "/v1/templates/blue-sky/evaluate" and template_service is not None) and not (self.path == "/v1/templates/blue-sky/verify-cutouts" and cutout_service is not None):
                self.send_json(404, {"error": "not_found"})
                return
            authorization = self.headers.get("Authorization", "")
            if not hmac.compare_digest(authorization.encode("utf-8"), ("Bearer " + session_token).encode("utf-8")):
                self.send_json(401, {"error": "unauthorized"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if not 0 < length <= MAX_BODY_BYTES:
                self.send_json(413, {"error": "invalid_body_size"})
                return
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                self.send_json(415, {"error": "unsupported_media_type"})
                return
            try:
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ContractError("incomplete_body")
                payload = json.loads(raw)
                if self.path == "/v1/analyze":
                    result = service.analyze(payload)
                elif self.path == "/v1/templates/blue-sky/verify-cutouts":
                    result = cutout_service.verify(payload)
                else:
                    result = template_service.evaluate(payload)
                self.send_json(200, result)
            except (ValueError, UnicodeError):
                self.send_json(400, {"error": "invalid_analysis_request"})
            except Exception:
                self.send_json(503, {"error": "analysis_unavailable"})
    return Handler


def main():
    token = os.getenv("ECHOO_GATEWAY_SESSION_TOKEN", "")
    if len(token) < 20:
        raise SystemExit("Set ECHOO_GATEWAY_SESSION_TOKEN to a random local-development token of at least 20 characters.")
    service = AnalysisService(AliModerationProvider(), QwenProvider())
    server = ThreadingHTTPServer(
        ("127.0.0.1", int(os.getenv("ECHOO_GATEWAY_PORT", "8787"))),
        make_handler(service, token, BlueSkyService(BlueSkyQwenProvider()), CutoutVerificationService(QwenCutoutProvider()))
    )
    print("Echoo development gateway is listening on loopback. No requests are sent until a client explicitly calls it.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
