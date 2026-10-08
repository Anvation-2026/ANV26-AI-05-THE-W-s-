"""POST /v1/demand/estimate: counts or a perception result in, a demand profile out. Same maths as the browser."""

from __future__ import annotations

from ..models.contracts import (
    APPROACHES,
    DemandEstimate,
    DemandEstimateRequest,
    DemandProfile,
    PerceptionResult,
    SatFlowOut,
)
from .estimate import ArriveRec, BinnedCounts, EstimatedDemand, bin_arrivals, bin_counts_rows, estimate_demand


def _perception_bins(r: PerceptionResult, bin_seconds: float) -> tuple[BinnedCounts, list[str]]:
    """Arrivals are counted on the upstream line, as in the browser. An approach with no upstream events at all
    falls back to its stop-line events, and the response says so."""
    duration = max(bin_seconds, max((f.t for f in r.frames), default=0.0) + bin_seconds)
    events = r.counts or []
    notes: list[str] = []
    recs: list[ArriveRec] = []
    for ap_i, ap in enumerate(APPROACHES):
        up = [c for c in events if c.approach == ap and c.line == "upstream"]
        stop = [c for c in events if c.approach == ap and c.line == "stop"]
        use = up
        if not up and stop:
            use = stop
            notes.append(f"{ap} has no upstream counts, so its stop-line counts were used. Demand may be under-estimated when the queue is long.")
        recs.extend(ArriveRec(c.t, ap_i, c.cls) for c in use)
    return bin_arrivals(recs, duration, bin_seconds), notes


def _profile(est: EstimatedDemand) -> DemandProfile:
    return DemandProfile(binSeconds=est.bin_seconds, duration=est.duration, rates=est.rates, mix=est.mix)


def estimate(req: DemandEstimateRequest) -> DemandEstimate:
    p = req.params.model_copy(
        update={
            "smoothing": req.smoothing if req.smoothing is not None else req.params.smoothing,
            "binSeconds": req.binSeconds if req.binSeconds is not None else req.params.binSeconds,
        }
    )
    default_sat = SatFlowOut(perLane=req.params.satFlowPerLane, startupLost=req.params.startupLost, headways=[], samples=0, isDefault=True)
    src = req.source
    notes: list[str] = []
    if src.kind == "counts":
        binned, _ = bin_counts_rows(src.rows, p.binSeconds)
        est = estimate_demand(binned, p, p.smoothing)
        sat = default_sat
        kind = "counts"
    else:
        binned, notes = _perception_bins(src.result, p.binSeconds)
        est = estimate_demand(binned, p, p.smoothing)
        kind = "perception"
        sf = src.result.satFlow
        sat = SatFlowOut(perLane=sf.perLane, startupLost=sf.startupLost, headways=sf.headways, samples=sf.samples, isDefault=sf.isDefault) if sf else default_sat
    profile = _profile(est)
    if kind == "perception":
        profile.satFlowMeasured = sat.perLane
        profile.satFlowIsDefault = sat.isDefault
        profile.startupLostMeasured = sat.startupLost
    out = DemandEstimate(
        profile=profile, rawPcu=est.raw_pcu, smoothPcu=est.smooth_pcu, totals=est.totals, satFlow=sat, source=kind, binSeconds=p.binSeconds, warnings=notes
    )
    return out
