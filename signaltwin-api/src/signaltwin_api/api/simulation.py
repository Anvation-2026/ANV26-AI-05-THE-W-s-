"""Simulation and experiments. The browser simulator is the reference; this runs the same rules on the server."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.concurrency import run_in_threadpool

from .. import errors
from ..models.contracts import (
    AblationRequest,
    CompareRequest,
    ExperimentRequest,
    GridRequest,
    NoiseRequest,
    SimRequest,
)
from ..sim.experiment import simulate
from .context import AppContext, guard
from .jobs import job_view

router = APIRouter(prefix="/v1", tags=["simulation"])


def experiment_runs(req: CompareRequest | AblationRequest | NoiseRequest | GridRequest) -> int:
    if isinstance(req, CompareRequest):
        return req.seeds * len(req.kinds)
    if isinstance(req, AblationRequest):
        return req.seeds * 5
    if isinstance(req, NoiseRequest):
        return req.seeds * (len(req.levels) + 1)
    return len(req.betas) * len(req.gammas) * req.seeds


@router.post("/simulate")
async def run_simulation(req: SimRequest, c: AppContext = Depends(guard)) -> dict[str, Any]:
    """One run of one controller: metrics, the decision log and the queue and lamp series."""
    if req.params.horizon > c.settings.max_sim_horizon_s:
        raise errors.simulation_too_long(req.params.horizon, c.settings.max_sim_horizon_s)
    return await run_in_threadpool(simulate, req)


@router.post("/experiments", status_code=202)
async def create_experiment(req: ExperimentRequest, request: Request, response: Response, c: AppContext = Depends(guard)) -> dict[str, Any]:
    """Start a comparison, ablation, noise sweep or grid search as a job. Follow it with /v1/jobs/{id}/events."""
    runs = experiment_runs(req)
    horizon = req.setup.params.horizon
    if runs * horizon > c.settings.max_experiment_work:
        raise errors.experiment_too_large(runs, horizon, c.settings.max_experiment_work)
    cid = getattr(request.state, "correlation_id", None)
    job, reused = await run_in_threadpool(c.jobs.submit_experiment, req.model_dump(mode="json"), cid)
    if job.state == "done":
        response.status_code = 200
    return job_view(job, reused)
