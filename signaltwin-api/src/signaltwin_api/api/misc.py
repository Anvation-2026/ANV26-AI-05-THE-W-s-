"""Health, limits, demand estimation and the saved junction."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool

from .. import errors
from ..config import API_VERSION, PIPELINE_VERSION
from ..demand.service import estimate
from ..models.contracts import DemandEstimate, DemandEstimateRequest, JunctionConfig
from ..perception.detector import list_models, model_view
from .context import AppContext, ctx_of, guard

router = APIRouter(prefix="/v1", tags=["service"])


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    """Open to everyone. The front end calls this at start-up to decide between the back end and its built-in mock."""
    c = ctx_of(request)
    s = c.settings
    if s.detector in ("synthetic", "stub"):
        model_ok, model_name = True, s.detector
    else:
        path = Path(s.model_weights_5class or s.model_weights)
        model_ok, model_name = path.exists(), path.stem
    free = await run_in_threadpool(c.storage.free_bytes)
    return {
        "status": "ok" if model_ok else "degraded",
        "version": API_VERSION,
        "pipelineVersion": PIPELINE_VERSION,
        "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "uptimeS": round(time.time() - c.started_at, 1),
        "model": {"available": model_ok, "name": model_name, "detector": s.detector},
        "storage": {"kind": s.storage, "freeGb": round(free / 1e9, 1)},
        "queue": c.jobs.stats(),
        "authRequired": bool(s.api_key),
        "message": None if model_ok else "The detection model file is missing. Uploading works but analysing videos will fail.",
    }


@router.get("/limits")
async def limits(c: AppContext = Depends(guard)) -> dict[str, Any]:
    s = c.settings
    return {
        "maxUploadMb": s.max_upload_mb,
        "maxDurationS": s.max_duration_s,
        "minDurationS": 3,
        "maxWidth": s.max_width,
        "maxProcessingWidth": s.max_proc_width,
        "acceptedFormats": ["mp4", "m4v", "mov", "mkv", "webm", "avi"],
        "retentionHours": s.retention_hours,
        "queueMax": s.queue_max,
        "workers": s.workers,
        "targetFps": s.target_fps,
        "rateLimitPerMinute": s.rate_limit_per_minute,
        "uploadLimitPerHour": s.upload_limit_per_hour,
        "maxJsonKb": s.max_json_kb,
        "models": [{"name": n, "view": model_view(n)} for n in list_models(s)] if s.detector == "yolo" else [],
    }


@router.post("/demand/estimate", response_model=DemandEstimate)
async def demand_estimate(req: DemandEstimateRequest, c: AppContext = Depends(guard)) -> DemandEstimate:
    """Counts (or a perception result) to a demand profile. Same arithmetic as the browser, checked by golden tests."""
    if req.source.kind == "counts" and not req.source.rows:
        raise errors.invalid_request("The counts have no rows.", "Add at least one row with time, approach, class and count.")
    if req.source.kind == "perception" and not (req.source.result.counts or []):
        raise errors.invalid_request(
            "No vehicles were counted in the analysis.",
            "Check that the upstream and stop lines are drawn across the road where vehicles drive, that the video shows traffic, and analyse it again.",
        )
    return await run_in_threadpool(estimate, req)


@router.get("/junction")
async def get_junction(c: AppContext = Depends(guard)) -> dict[str, Any]:
    j = await run_in_threadpool(c.storage.get_junction)
    if j is None:
        raise errors.ApiError("not_found", 404, "No junction is saved", "Nothing has been saved on the server yet.", "Save the junction from Setup first.")
    return j


@router.put("/junction")
async def put_junction(j: JunctionConfig, c: AppContext = Depends(guard)) -> dict[str, Any]:
    data = j.model_dump(mode="json")
    await run_in_threadpool(c.storage.put_junction, data)
    return data
