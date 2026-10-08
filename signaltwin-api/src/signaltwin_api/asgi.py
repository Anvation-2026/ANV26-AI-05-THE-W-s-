"""Small pure-ASGI middleware. Pure ASGI (not BaseHTTPMiddleware) so streaming and server-sent events are not buffered."""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import errors
from .logging_setup import correlation_var

log = logging.getLogger("signaltwin.http")


class CorrelationMiddleware:
    """Gives every request a correlation id (from the caller or new), logs it, and adds safe default headers."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        raw = dict(scope.get("headers") or [])
        cid = raw.get(b"x-correlation-id", b"").decode("latin-1")[:64]
        if not cid or not all(c.isalnum() or c in "-_." for c in cid):
            cid = uuid.uuid4().hex[:12]
        scope.setdefault("state", {})["correlation_id"] = cid
        token = correlation_var.set(cid)
        started = time.perf_counter()
        status = 0

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = list(message.get("headers") or [])
                headers.append((b"x-correlation-id", cid.encode()))
                headers.append((b"x-content-type-options", b"nosniff"))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            correlation_var.reset(token)
            log.info(
                "request",
                extra={
                    "correlation_id": cid,
                    "method": scope.get("method"),
                    "path": scope.get("path"),
                    "status": status,
                    "ms": round((time.perf_counter() - started) * 1000, 1),
                },
            )


class BodyLimitMiddleware:
    """Rejects JSON bodies over a limit. Uploads under /v1/videos have their own, larger, limit checked while streaming."""

    UPLOAD_PATH = "/v1/videos"

    def __init__(self, app: ASGIApp, max_kb: int) -> None:
        self.app = app
        self.max_bytes = max_kb * 1024
        self.max_kb = max_kb

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") not in ("POST", "PUT", "PATCH"):
            await self.app(scope, receive, send)
            return
        if scope.get("method") == "POST" and str(scope.get("path", "")).rstrip("/") == self.UPLOAD_PATH:
            await self.app(scope, receive, send)
            return
        raw = dict(scope.get("headers") or [])
        try:
            declared = int(raw.get(b"content-length", b"0") or 0)
        except ValueError:
            declared = 0
        if declared > self.max_bytes:
            await self._reject(scope, receive, send)
            return
        seen = 0

        async def counting_receive() -> Message:
            nonlocal seen
            message: dict[str, Any] = dict(await receive())
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise errors.body_too_large(self.max_kb)
            return message

        await self.app(scope, counting_receive, send)

    async def _reject(self, scope: Scope, receive: Receive, send: Send) -> None:
        cid = (scope.get("state") or {}).get("correlation_id")
        resp = errors.problem_response(errors.body_too_large(self.max_kb), cid)
        await resp(scope, receive, send)
