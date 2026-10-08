"""Shared objects for request handlers, rate limiting and the optional API key."""

from __future__ import annotations

import hmac
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field

from fastapi import Request

from .. import errors
from ..config import Settings
from ..jobs.manager import JobManager
from ..storage.base import Storage


class RateLimiter:
    """Sliding window per client. In memory, so it limits one process; a shared proxy limit is advised for scale-out."""

    def __init__(self, limit: int, window_s: float) -> None:
        self.limit = limit
        self.window = window_s
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> int | None:
        """None if allowed, otherwise seconds until a slot frees."""
        if self.limit <= 0:
            return None
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return max(1, int(self.window - (now - q[0])) + 1)
            q.append(now)
            if len(self._hits) > 10_000:  # drop idle clients so memory stays bounded
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] > self.window]:
                    self._hits.pop(k, None)
            return None


@dataclass
class AppContext:
    settings: Settings
    storage: Storage
    jobs: JobManager
    limiter: RateLimiter
    upload_limiter: RateLimiter
    started_at: float = field(default_factory=time.time)
    _locks: dict[str, threading.Lock] = field(default_factory=dict)
    _locks_guard: threading.Lock = field(default_factory=threading.Lock)

    def lock_for(self, key: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(key, threading.Lock())


def ctx_of(request: Request) -> AppContext:
    return request.app.state.ctx  # type: ignore[no-any-return]


def client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def guard(request: Request) -> AppContext:
    """Dependency for every route except health: API key (if configured) and a per-client rate limit."""
    c = ctx_of(request)
    if c.settings.api_key:
        given = request.headers.get("x-api-key") or request.query_params.get("api_key") or ""
        if not hmac.compare_digest(given.encode(), c.settings.api_key.encode()):
            raise errors.unauthorized()
    wait = c.limiter.check(client_key(request))
    if wait is not None:
        raise errors.rate_limited(wait)
    return c
