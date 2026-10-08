"""Running simulations and experiments. Port of src/engine/experiment.ts."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ..models.contracts import (
    AblationRequest,
    CompareRequest,
    ControllerKind,
    GridRequest,
    NoiseRequest,
    NoiseSpec,
    RunSetup,
    SimRequest,
)
from .engine import Sim, SimConfig
from .jsnum import js_round
from .metrics import build_comparison, compute_metrics, paired_stats, stat_set
from .plans import scenario_profile, webster_plan

NO_NOISE = NoiseSpec(missRate=0, labelError=0, delaySec=0)


class Cancelled(Exception):
    """The caller asked to stop."""


def noise_at(pct: float) -> NoiseSpec:
    return NoiseSpec(missRate=pct / 100, labelError=(pct / 100) * 0.5, delaySec=js_round(pct / 10))


def profile_for(s: RunSetup):  # type: ignore[no-untyped-def]
    return scenario_profile(s.baseDemand, s.scenario, s.params, s.params.horizon)


def make_sim(s: RunSetup, kind: str, seed: int, profile=None, record: bool = False) -> Sim:  # type: ignore[no-untyped-def]
    profile = profile if profile is not None else profile_for(s)
    greens = webster_plan(profile, s.params).greens if kind == "webster" else None
    cfg = SimConfig(
        params=s.params,
        demand=profile,
        kind=kind,
        options=s.options,
        seed=seed,
        horizon=s.params.horizon,
        noise=(s.noise or NO_NOISE) if kind == "signaltwin" else NO_NOISE,
        emergencies=s.emergencies or [],
        observed=s.observed,
        webster_greens=greens,
        record=record,
    )
    return Sim(cfg)


def run_one(s: RunSetup, kind: str, seed: int, profile=None) -> dict[str, float]:  # type: ignore[no-untyped-def]
    return compute_metrics(make_sim(s, kind, seed, profile).run())


def simulate(req: SimRequest) -> dict[str, Any]:
    """POST /v1/simulate: one run, with the decision log and the series the charts draw."""
    setup = RunSetup(
        params=req.params, options=req.options, baseDemand=req.baseDemand, scenario=req.scenario, observed=req.observed, noise=req.noise, emergencies=req.emergencies
    )
    sim = make_sim(setup, req.controller, req.seed).run()
    return {
        "metrics": compute_metrics(sim),
        "decisions": sim.decisions,
        "queue": sim.q_series,
        "lamps": sim.lamp_series,
        "seed": req.seed,
        "horizon": req.params.horizon,
    }


Progress = Callable[[int, int, str], None]


def run_experiment(req: CompareRequest | AblationRequest | NoiseRequest | GridRequest, on_progress: Progress, is_cancelled: Callable[[], bool]) -> dict[str, Any]:
    s = req.setup
    profile = profile_for(s)

    def check() -> None:
        if is_cancelled():
            raise Cancelled()

    if isinstance(req, CompareRequest):
        per: dict[str, list[dict[str, float]]] = {k: [] for k in req.kinds}
        for i in range(req.seeds):
            check()
            for k in req.kinds:
                per[k].append(run_one(s, k, i + 1, profile))
            on_progress(i + 1, req.seeds, f"Seed {i + 1} of {req.seeds}")
        return {"type": "compare", "result": build_comparison(s.scenario.id, s.params.horizon, per)}

    if isinstance(req, AblationRequest):
        variants: list[tuple[str, str, dict[str, Any]]] = [
            ("full", "Full SignalTwin", {}),
            ("noFairness", "Without fairness guard", {"fairnessGuard": False}),
            ("noLookahead", "Without platoon look-ahead", {"lookahead": False}),
            ("noPcu", "Without PCU weighting", {"pcuWeighting": False}),
            ("noHyst", "Without hysteresis", {"hysteresisOn": False}),
        ]
        metrics: dict[str, list[dict[str, float]]] = {v[0]: [] for v in variants}
        total = req.seeds * len(variants)
        done = 0
        for i in range(req.seeds):
            check()
            for vid, _label, patch in variants:
                setup = s.model_copy(update={"options": s.options.model_copy(update=patch)})
                metrics[vid].append(run_one(setup, "signaltwin", i + 1, profile))
                done += 1
            on_progress(done, total, f"Seed {i + 1} of {req.seeds}")
        rows = [
            {
                "id": vid,
                "label": label,
                "metrics": metrics[vid],
                "stats": stat_set(metrics[vid]),
                "vsFull": None if vid == "full" else paired_stats(metrics["full"], metrics[vid]),
            }
            for vid, label, _ in variants
        ]
        return {"type": "ablation", "rows": rows, "seeds": req.seeds}

    if isinstance(req, NoiseRequest):
        out_rows: list[dict[str, Any]] = []
        web = [run_one(s, "webster", i + 1, profile) for i in range(req.seeds)]
        total = len(req.levels) * req.seeds
        done = 0
        for level in req.levels:
            sig: list[dict[str, float]] = []
            for i in range(req.seeds):
                check()
                setup = s.model_copy(update={"noise": noise_at(level)})
                sig.append(run_one(setup, "signaltwin", i + 1, profile))
                done += 1
                if i % 4 == 3:
                    on_progress(done, total, f"Noise {_g(level)} percent, seed {i + 1} of {req.seeds}")
            out_rows.append({"level": level, "signaltwin": sig, "webster": web, "stSignal": stat_set(sig), "stWebster": stat_set(web)})
            on_progress(done, total, f"Noise {_g(level)} percent finished")
        return {"type": "noise", "rows": out_rows, "seeds": req.seeds}

    grid_rows: list[dict[str, Any]] = []
    total = len(req.betas) * len(req.gammas)
    done = 0
    for beta in req.betas:
        for gamma in req.gammas:
            check()
            setup = s.model_copy(update={"params": s.params.model_copy(update={"beta": beta, "gamma": gamma})})
            ms = [run_one(setup, "signaltwin", i + 1, profile) for i in range(req.seeds)]
            st = stat_set(ms)
            grid_rows.append(
                {
                    "beta": beta,
                    "gamma": gamma,
                    "avgDelay": st["avgDelayVeh"]["mean"],
                    "longestRed": st["longestRed"]["mean"],
                    "ok": all(m["longestRed"] <= s.params.fairnessCap for m in ms),
                }
            )
            done += 1
            on_progress(done, total, f"beta {_g(beta)}, gamma {_g(gamma)}")
    ok_rows = [r for r in grid_rows if r["ok"]]
    pool = ok_rows or grid_rows
    best = sorted(pool, key=lambda r: r["avgDelay"])[0] if pool else None
    return {"type": "grid", "rows": grid_rows, "best": best}


def _g(x: float) -> str:
    return str(int(x)) if x == int(x) else repr(x)


__all__ = ["Cancelled", "ControllerKind", "make_sim", "noise_at", "profile_for", "run_experiment", "run_one", "simulate"]
