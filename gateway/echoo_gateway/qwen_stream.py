"""Bounded SSE decoding. Partial model output is never a completed response."""
import json
import time


def read_completion(response, diagnostics, *, deadline, started=None, clock=time.monotonic):
    # Import here to avoid a circular dependency with the HTTP transport.
    from .providers import ProviderError

    parts, usage, finish, refusal = [], {}, None, False
    event, raw_bytes, content_bytes = [], 0, 0
    started = clock() if started is None else started
    while True:
        if clock() >= deadline:
            raise ProviderError("qwen_total_timeout")
        line = response.readline(65537)
        if clock() >= deadline:
            raise ProviderError("qwen_total_timeout")
        if not line:
            raise ProviderError("qwen_stream_incomplete")
        if diagnostics["firstDataMS"] is None:
            diagnostics["firstDataMS"] = round((clock() - started) * 1000)
        raw_bytes += len(line)
        diagnostics["receivedBytes"] = raw_bytes
        if len(line) > 65536 or raw_bytes > 2 * 1024 * 1024:
            raise ProviderError("qwen_response_too_large")
        try:
            line = line.decode("utf-8").rstrip("\r\n")
        except UnicodeDecodeError:
            raise ProviderError("qwen_invalid_stream") from None
        if line.startswith("data:"):
            event.append(line[5:].removeprefix(" "))
            if sum(map(len, event)) > 262144:
                raise ProviderError("qwen_response_too_large")
        elif line or not event:
            continue  # Comments and other SSE fields do not contain completion data.
        else:
            data = "\n".join(event)
            event = []
            diagnostics["events"] += 1
            if diagnostics["events"] > 50000:
                raise ProviderError("qwen_response_too_large")
            if data == "[DONE]":
                if finish is None or not parts:
                    raise ProviderError("qwen_stream_incomplete")
                return {"choices": [{"finish_reason": finish, "message": {
                    "content": "".join(parts), "refusal": refusal}}], "usage": usage}
            try:
                chunk = json.loads(data)
                if "error" in chunk:
                    raise ProviderError("qwen_stream_error")
                if isinstance(chunk.get("usage"), dict):
                    usage = {k: v for k, v in chunk["usage"].items()
                             if k in ("prompt_tokens", "completion_tokens", "total_tokens")
                             and type(v) is int and v >= 0}
                choices = chunk["choices"]
                if not isinstance(choices, list) or len(choices) > 1:
                    raise ValueError()
                if not choices:
                    continue  # Optional final usage-only chunk.
                choice = choices[0]
                if choice.get("index", 0) != 0:
                    raise ValueError()
                delta = choice["delta"]
                text = delta.get("content")
                if delta.get("refusal"):
                    refusal = True
                if text is not None:
                    if not isinstance(text, str) or finish is not None:
                        raise ValueError()
                    content_bytes += len(text.encode("utf-8"))
                    diagnostics["contentBytes"] = content_bytes
                    if content_bytes > 256 * 1024:
                        raise ProviderError("qwen_response_too_large")
                    parts.append(text)
                reason = choice.get("finish_reason")
                if reason is not None:
                    if not isinstance(reason, str) or finish is not None:
                        raise ValueError()
                    finish = reason
            except (ValueError, KeyError, TypeError, AttributeError):
                raise ProviderError("qwen_invalid_stream") from None
