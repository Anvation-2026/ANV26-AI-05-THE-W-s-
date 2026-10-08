"""Application factory. Run with:  uvicorn signaltwin_api.main:app --port 8000"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import jobs as jobs_routes
from .api import misc as misc_routes
from .api import simulation as sim_routes
from .api import videos as video_routes
from .api.context import AppContext, RateLimiter
from .asgi import BodyLimitMiddleware, CorrelationMiddleware
from .config import API_VERSION, Settings, get_settings
from .errors import install_error_handlers
from .jobs.manager import JobManager
from .logging_setup import configure_logging
from .storage.base import Storage
from .storage.local import LocalStorage

log = logging.getLogger("signaltwin")


def build_storage(settings: Settings) -> Storage:
    if settings.storage == "supabase":
        from .storage.supabase import SupabaseStorage  # imported late: needs the 'supabase' extra

        return cast(Storage, SupabaseStorage(settings))
    return LocalStorage(settings.data_dir)


async def _janitor(ctx: AppContext) -> None:
    """Deletes expired videos and stale partial uploads every ten minutes."""
    while True:
        try:
            removed = await asyncio.to_thread(ctx.storage.purge_expired, ctx.settings.retention_hours)
            if any(removed.values()):
                log.info("purged expired data", extra=removed)
        except Exception:  # noqa: BLE001 - housekeeping must never stop the server
            log.exception("purge failed")
        await asyncio.sleep(600)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        storage = build_storage(settings)
        storage.init()
        jobs = JobManager(settings, storage)
        ctx = AppContext(
            settings=settings,
            storage=storage,
            jobs=jobs,
            limiter=RateLimiter(settings.rate_limit_per_minute, 60.0),
            upload_limiter=RateLimiter(settings.upload_limit_per_hour, 3600.0),
        )
        app.state.ctx = ctx
        jobs.start()
        janitor = asyncio.create_task(_janitor(ctx))
        log.info("started", extra={"version": API_VERSION, "storage": settings.storage, "detector": settings.detector})
        try:
            yield
        finally:
            janitor.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await janitor
            jobs.stop()

    app = FastAPI(
        title="SignalTwin API",
        version=API_VERSION,
        description="Video analytics and demand estimation for SignalTwin. Errors are RFC 7807 problem+json with a plain-language `fix`.",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url=None,
    )
    install_error_handlers(app)
    app.add_middleware(BodyLimitMiddleware, max_kb=settings.max_json_kb)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.origins,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-API-Key", "X-Filename", "X-Correlation-Id", "Last-Event-ID", "Range"],
        expose_headers=["X-Correlation-Id", "Retry-After", "Content-Range", "Accept-Ranges", "Content-Length", "ETag"],
        max_age=600,
    )
    app.add_middleware(CorrelationMiddleware)
    app.include_router(misc_routes.router)
    app.include_router(video_routes.router)
    app.include_router(jobs_routes.router)
    app.include_router(sim_routes.router)
    return app


app = create_app()
