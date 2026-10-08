"""Perception jobs: create, status, live events (SSE), result, cancel."""

from __future__ import annotations

import asyncio
import gzip
import json
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse

from .. import errors
from ..errors import PROBLEM_JSON
from ..models.contracts import PerceptionJobRequest
from ..perception.geometry import validate_junction
from ..storage.base import TERMINAL_STATES, JobRecord
from .context import AppContext, guard

router = APIRouter(prefix="/v1", tags=["jobs"])


def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ") if ts else None


def job_view(j: JobRecord, reused: bool | None = None) -> dict[str, Any]:
    d: dict[str, Any] = {
        "jobId": j.id,
        "videoId": j.video_id,
        "state": j.state,
        "progress": j.progress,
        "error": j.error,
        "fromCache": j.from_cache,
        "cancelRequested": j.cancel_requested,
        "createdAt": _iso(j.created_at),
        "startedAt": _iso(j.started_at),
        "finishedAt": _iso(j.finished_at),
        "links": {"events": f"/v1/jobs/{j.id}/events", "result": f"/v1/jobs/{j.id}/result", "cancel": f"/v1/jobs/{j.id}/cancel"},
    }
    if reused is not None:
        d["reused"] = reused
    return d


def _job(c: AppContext, job_id: str) -> JobRecord:
    j = c.storage.get_job(job_id)
    if j is None:
        raise errors.job_not_found(job_id)
    return j


@router.post("/perception/jobs", status_code=202)
async def create_job(req: PerceptionJobRequest, request: Request, response: Response, c: AppContext = Depends(guard)) -> dict[str, Any]:
    """Start analysing an uploaded video. Identical requests share one job and a finished identical request is answered from cache."""
    video = c.storage.get_video(req.videoId)
    if video is None:
        raise errors.video_not_found(req.videoId)
    # reject an unusable drawing now, in plain words, instead of after minutes of work
    await run_in_threadpool(validate_junction, req.junction, video.width, video.height)
    cid = getattr(request.state, "correlation_id", None)
    job, reused = await run_in_threadpool(c.jobs.submit, req, video, cid)
    if job.state == "done":
        response.status_code = 200
    return job_view(job, reused)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, c: AppContext = Depends(guard)) -> dict[str, Any]:
    return job_view(_job(c, job_id))


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, c: AppContext = Depends(guard)) -> dict[str, Any]:
    _job(c, job_id)
    out = await run_in_threadpool(c.jobs.cancel, job_id)
    assert out is not None
    return job_view(out)


@router.get("/jobs/{job_id}/result")
async def get_result(job_id: str, request: Request, download: bool = False, c: AppContext = Depends(guard)) -> Response:
    j = _job(c, job_id)
    if j.state == "cancelled":
        raise errors.job_cancelled()
    if j.state == "error":
        e = j.error or {}
        return JSONResponse(e or errors.job_failed("unknown").problem(), status_code=int(e.get("status", 500)), media_type=PROBLEM_JSON)
    if j.state != "done":
        raise errors.job_not_ready(j.state)
    blob = await run_in_threadpool(c.storage.load_result, j.cache_key)
    if blob is None:
        raise errors.ApiError(
            "job_not_found", 404, "The result is no longer stored", "The result was deleted after the retention period or with its video.",
            "Start the analysis again.",
        )
    headers = {"ETag": f'"{j.cache_key}"', "Cache-Control": "private, max-age=3600"}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="signaltwin-{j.video_id}.json"'
    accept = request.headers.get("accept-encoding", "gzip")
    if "gzip" in accept or "*" in accept or not accept:
        headers["Content-Encoding"] = "gzip"
        return Response(blob, media_type="application/json", headers=headers)
    return Response(gzip.decompress(blob), media_type="application/json", headers=headers)


TERMINAL_EVENTS = {"done", "error", "cancelled"}


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request, lastEventId: int = 0, c: AppContext = Depends(guard)) -> StreamingResponse:
    """Server-sent events. Reconnect with the Last-Event-ID header to continue exactly where the stream stopped."""
    _job(c, job_id)
    header = request.headers.get("last-event-id", "")
    start = int(header) if header.isdigit() else lastEventId

    async def gen() -> AsyncIterator[str]:
        last = start
        beat = time.monotonic()
        yield "retry: 2000\n\n"
        while True:
            events = await run_in_threadpool(c.storage.events_since, job_id, last)
            for seq, typ, data in events:
                last = seq
                yield f"id: {seq}\nevent: {typ}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
                if typ in TERMINAL_EVENTS:
                    return
            if not events:
                job = await run_in_threadpool(c.storage.get_job, job_id)
                if job is None:
                    return
                if job.state in TERMINAL_STATES:
                    # no terminal event was stored (for example after a restart): say the final state once
                    yield f"event: {job.state}\ndata: {json.dumps({'state': job.state, 'problem': job.error})}\n\n"
                    return
            if await request.is_disconnected():
                return
            if time.monotonic() - beat > 15:
                beat = time.monotonic()
                yield ": keep-alive\n\n"
            await asyncio.sleep(0.25)

    return StreamingResponse(
        gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}
    )
