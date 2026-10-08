"""Python port of the browser's simulator (src/engine/sim.ts). Same rules, same random numbers, same sentences.

Parity with the browser is checked by tests/golden/sim.json, produced by scripts/fixtures.ts. The browser engine is
the source of truth: change it first, regenerate the fixtures, then bring this file in line.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from ..models.contracts import (
    VEHICLE_CLASSES,
    ControllerOptions,
    DemandProfile,
    EmergencyEvent,
    NoiseSpec,
    ObservedTiming,
    Params,
)
from .jsnum import hash01, js_round, mulberry32, num, pick_class, poisson, to_fixed

AP_NAMES = ["North", "South", "East", "West"]


def phases_for(four_phase: bool) -> list[list[int]]:
    return [[0], [1], [2], [3]] if four_phase else [[0, 1], [2, 3]]


def phase_name(phase: list[int], names: list[str] | None = None) -> str:
    names = names or ["N", "S", "E", "W"]
    if len(phase) == 2 and phase[0] == 0 and phase[1] == 1:
        return "NS"
    if len(phase) == 2 and phase[0] == 2 and phase[1] == 3:
        return "EW"
    return "".join(names[i] for i in phase)


class Veh:
    __slots__ = ("id", "cls", "pcu", "people", "ap", "arrive_t", "eta_queue", "queue_t", "depart_t", "emergency", "speed")

    def __init__(self, id: int, cls: str, pcu: float, people: float, ap: int, arrive_t: int, eta_queue: float, emergency: bool, speed: float) -> None:
        self.id = id
        self.cls = cls
        self.pcu = pcu
        self.people = people
        self.ap = ap
        self.arrive_t = arrive_t
        self.eta_queue = eta_queue
        self.queue_t = -1
        self.depart_t = -1
        self.emergency = emergency
        self.speed = speed

    def copy(self) -> Veh:
        v = Veh(self.id, self.cls, self.pcu, self.people, self.ap, self.arrive_t, self.eta_queue, self.emergency, self.speed)
        v.queue_t = self.queue_t
        v.depart_t = self.depart_t
        return v


@dataclass
class SignalState:
    phase: int
    stage: str  # green | yellow | allred
    stage_t: int
    next: int


@dataclass
class View:
    t: int
    signal: SignalState
    phases: list[list[int]]
    q: list[float]
    e: list[float]
    red: list[int]
    lam: list[float]
    emergency: list[int]
    names: list[str]
    q_count: list[int]
    arr_soon: list[int]
    standing_left: int
    standing_start: int


@dataclass
class Decision:
    switch_to: int | None
    rule: str
    reason: str
    approaches: list[int]


@dataclass
class SimConfig:
    params: Params
    demand: DemandProfile
    kind: str
    options: ControllerOptions
    seed: int
    horizon: int
    noise: NoiseSpec
    emergencies: list[EmergencyEvent]
    observed: ObservedTiming
    webster_greens: list[float] | None = None
    names: list[str] | None = None
    record: bool = False


def build_arrivals(cfg: SimConfig) -> list[list[Veh]]:
    params, demand, horizon = cfg.params, cfg.demand, cfg.horizon
    out: list[list[Veh]] = [[] for _ in range(horizon + 1)]
    vid = 1
    for ap in range(4):
        rng = mulberry32(cfg.seed * 7919 + ap * 104729 + 17)
        rates = demand.rates[ap]
        mix = demand.mix[ap]
        for t in range(horizon):
            b = min(len(rates) - 1, math.floor(t / demand.binSeconds))
            n = poisson(rng, rates[b])
            for _ in range(n):
                cls = pick_class(rng, mix, VEHICLE_CLASSES)
                travel = params.travelMin + rng() * (params.travelMax - params.travelMin)
                spec = params.classes[cls]  # type: ignore[index]
                out[t].append(Veh(vid, cls, spec.pcu, spec.people, ap, t, t + max(1, js_round(travel)), False, 50 / travel))
                vid += 1
    k = 0
    for ev in cfg.emergencies:
        if ev.t < 0 or ev.t >= horizon:
            continue
        spec = params.classes["car"]
        out[int(ev.t)].append(Veh(9_000_000 + k, "car", spec.pcu, 3, int(ev.approach), int(ev.t), ev.t + 8, True, 50 / 8))
        k += 1
    return out


class Sim:
    def __init__(self, cfg: SimConfig) -> None:
        self.cfg = cfg
        self.params = cfg.params
        self.phases = phases_for(cfg.params.fourPhase)
        self.names = cfg.names or AP_NAMES
        self.arrivals = build_arrivals(cfg)
        self.t = 0
        self.transit: list[list[Veh]] = [[], [], [], []]
        self.queue: list[deque[Veh]] = [deque(), deque(), deque(), deque()]
        self.accum = [0.0, 0.0, 0.0, 0.0]
        self.signal = SignalState(0, "green", 0, 0)
        self.red = [0, 0, 0, 0]
        self.max_red = [0, 0, 0, 0]
        self.lam = [0.0, 0.0, 0.0, 0.0]
        self.waits: list[float] = []
        self.wait_sum = [0.0, 0.0, 0.0, 0.0]
        self.wait_count = [0, 0, 0, 0]
        self.people_wait = 0.0
        self.people_count = 0.0
        self.served = 0
        self.served_people = 0.0
        self.max_queue = [0.0, 0.0, 0.0, 0.0]
        self.decisions: list[dict[str, Any]] = []
        self.q_series: list[list[float]] = [[], [], [], []]
        self.lamp_series: list[list[int]] = [[], [], [], []]
        self.emergency_outstanding = 0
        self.emergency_delay_cost = 0
        self.last_hold_log_t = -100
        self.standing: set[int] = set()
        self.standing_start = 0
        self.green_starts: list[dict[str, float]] = [{"t": 0, "phase": 0}]
        self.controller: Controller = create_controller(cfg, self.phases)

    # ------------------------------------------------------------------ what the controller may see
    def build_view(self) -> View:
        o, noise, params = self.cfg.options, self.cfg.noise, self.params
        seed = self.cfg.seed
        people = o.objective == "people"

        def w(cls: str) -> float:
            spec = params.classes[cls]  # type: ignore[index]
            if people:
                return spec.people
            return spec.pcu if o.pcuWeighting else 1

        q = [0.0, 0.0, 0.0, 0.0]
        e = [0.0, 0.0, 0.0, 0.0]
        q_count = [0, 0, 0, 0]
        arr_soon = [0, 0, 0, 0]
        standing_left = 0

        def seen(v: Veh) -> str | None:
            if v.emergency:
                return v.cls
            if noise.missRate > 0 and hash01(v.id * 31 + seed) < noise.missRate:
                return None
            if noise.labelError > 0 and hash01(v.id * 17 + seed + 5) < noise.labelError:
                return "car"
            return v.cls

        emergency: list[int] = []
        cur_aps = self.phases[self.signal.phase]
        for ap in range(4):
            for v in self.queue[ap]:
                c = seen(v)
                if c:
                    q[ap] += w(c)
                    q_count[ap] += 1
                    if ap in cur_aps and v.id in self.standing:
                        standing_left += 1
                if v.emergency:
                    emergency.append(ap)
            for v in self.transit[ap]:
                if v.emergency:
                    emergency.append(ap)
                    continue
                c = seen(v)
                if not c:
                    continue
                if self.t - v.arrive_t < noise.delaySec:
                    continue
                if o.lookahead and v.eta_queue - self.t <= params.lookaheadH + 2:
                    e[ap] += w(c)
                if v.eta_queue - self.t <= params.vacGap:
                    arr_soon[ap] += 1
        return View(
            q_count=q_count,
            arr_soon=arr_soon,
            standing_left=standing_left,
            standing_start=self.standing_start,
            t=self.t,
            signal=self.signal,
            phases=self.phases,
            q=q,
            e=e,
            red=self.red,
            lam=self.lam,
            emergency=list(dict.fromkeys(emergency)) if o.emergencyPriority else [],
            names=self.names,
        )

    # ------------------------------------------------------------------ one second
    def step(self) -> None:
        t = self.t
        p = self.params
        o, noise = self.cfg.options, self.cfg.noise
        people = o.objective == "people"

        # 1. arrivals cross the upstream line
        arr = self.arrivals[t] if t < len(self.arrivals) else []
        arr_w = [0.0, 0.0, 0.0, 0.0]
        for v0 in arr:
            v = v0.copy()
            self.transit[v.ap].append(v)
            if v.emergency:
                self.emergency_outstanding += 1
            vis = v.emergency or not (noise.missRate > 0 and hash01(v.id * 31 + self.cfg.seed) < noise.missRate)
            if vis:
                arr_w[v.ap] += v.people if people else (v.pcu if o.pcuWeighting else 1)
        for ap in range(4):
            self.lam[ap] = self.lam[ap] * 0.98 + arr_w[ap] * 0.02

        # 2. transit to queue
        for ap in range(4):
            tr = self.transit[ap]
            if tr:
                still: list[Veh] = []
                ready: list[Veh] = []
                for v in tr:
                    (ready if v.eta_queue <= t else still).append(v)
                if ready:
                    ready.sort(key=lambda v: (v.eta_queue, v.id))
                    for v in ready:
                        v.queue_t = t
                        self.queue[ap].append(v)
                    self.transit[ap] = still

        # 3. controller decision (only acts on green)
        view = self.build_view()
        dec = self.controller.decide(view, p)
        if self.signal.stage == "green":
            if dec.switch_to is not None and dec.switch_to != self.signal.phase:
                self.decisions.append(
                    {
                        "t": t,
                        "rule": dec.rule,
                        "from": self.signal.phase,
                        "to": dec.switch_to,
                        "action": f"Switch to {phase_name(self.phases[dec.switch_to])}",
                        "reason": dec.reason,
                        "approaches": dec.approaches,
                    }
                )
                self.signal = SignalState(self.signal.phase, "yellow", 0, dec.switch_to)
            elif (
                self.cfg.kind in ("signaltwin", "vac")
                and t - self.last_hold_log_t >= 10
                and (dec.rule in ("emergency", "clearance", "extend") or (dec.rule == "stay" and self.signal.stage_t >= p.minGreen))
            ):
                self.last_hold_log_t = t
                ph = phase_name(self.phases[self.signal.phase])
                action = (
                    f"Hold {ph} green for emergency vehicle"
                    if dec.rule == "emergency"
                    else f"Clear the {ph} queue"
                    if dec.rule == "clearance"
                    else f"Extend {ph} green"
                    if dec.rule == "extend"
                    else f"Hold {ph} green"
                )
                self.decisions.append(
                    {"t": t, "rule": dec.rule, "from": self.signal.phase, "to": self.signal.phase, "action": action, "reason": dec.reason, "approaches": dec.approaches}
                )

        # 4. discharge
        sat = (p.satFlowPerLane * p.lanes) / 3600
        phase_aps = self.phases[self.signal.phase]
        flowing = self.signal.stage == "yellow" or (self.signal.stage == "green" and self.signal.stage_t >= p.startupLost)
        for ap in range(4):
            active = flowing and ap in phase_aps
            if not active:
                self.accum[ap] = 0
                continue
            q = self.queue[ap]
            if len(q) == 0:
                self.accum[ap] = 0
                continue
            self.accum[ap] += sat
            while q and self.accum[ap] >= q[0].pcu - 1e-9:
                v = q.popleft()
                self.accum[ap] -= v.pcu
                v.depart_t = t
                wait = t - v.queue_t
                self.waits.append(wait)
                self.wait_sum[ap] += wait
                self.wait_count[ap] += 1
                self.people_wait += wait * v.people
                self.people_count += v.people
                self.served += 1
                self.served_people += v.people
                if v.emergency:
                    self.emergency_outstanding = max(0, self.emergency_outstanding - 1)

        # 5. accounting
        for ap in range(4):
            qp = 0.0
            for v in self.queue[ap]:
                qp += v.pcu
            self.q_series[ap].append(qp)
            if qp > self.max_queue[ap]:
                self.max_queue[ap] = qp
            served = ap in phase_aps and self.signal.stage != "allred"
            if served:
                self.red[ap] = 0
            else:
                self.red[ap] += 1
            if self.red[ap] > self.max_red[ap]:
                self.max_red[ap] = self.red[ap]
            lamp = 0
            if ap in phase_aps:
                if self.signal.stage == "green":
                    lamp = 2
                elif self.signal.stage == "yellow":
                    lamp = 1
            self.lamp_series[ap].append(lamp)
        if self.emergency_outstanding > 0:
            for ap in range(4):
                if ap not in view.emergency:
                    self.emergency_delay_cost += len(self.queue[ap])

        # 6. advance the signal clock
        s = self.signal
        s.stage_t += 1
        if s.stage == "yellow" and s.stage_t >= p.yellow:
            s.stage = "allred"
            s.stage_t = 0
        elif s.stage == "allred" and s.stage_t >= p.allRed:
            s.phase = s.next
            s.stage = "green"
            s.stage_t = 0
            self.green_starts.append({"t": t + 1, "phase": s.phase})
            self.standing = {v.id for ap in self.phases[s.phase] for v in self.queue[ap]}
            self.standing_start = len(self.standing)
        self.t += 1

    def run(self, until: int | None = None) -> Sim:
        until = self.cfg.horizon if until is None else until
        while self.t < until:
            self.step()
        return self


# --------------------------------------------------------------------------- controllers


class Controller:
    kind: str

    def decide(self, view: View, p: Params) -> Decision:  # pragma: no cover - interface
        raise NotImplementedError


def create_controller(cfg: SimConfig, phases: list[list[int]]) -> Controller:
    if cfg.kind == "signaltwin":
        return SignalTwinController(cfg, phases)
    if cfg.kind == "vac":
        return VacController(cfg, phases)
    greens = cfg.webster_greens if cfg.kind == "webster" and cfg.webster_greens else pad_greens(cfg.observed.greens, len(phases), cfg.params.minGreen)
    return FixedController(cfg.kind, greens, phases)


def pad_greens(g: list[float], n: int, fallback: float) -> list[float]:
    out = list(g[:n])
    while len(out) < n:
        idx = len(out) % max(1, len(g))
        src = g[idx] if idx < len(g) else fallback
        out.append(max(fallback, src))
    return out


class FixedController(Controller):
    def __init__(self, kind: str, greens: list[float], phases: list[list[int]]) -> None:
        self.kind = kind
        self.greens = greens
        self.phases = phases

    def decide(self, view: View, p: Params) -> Decision:
        s = view.signal
        g = self.greens[s.phase]
        if s.stage == "green" and s.stage_t >= g:
            to = (s.phase + 1) % len(self.phases)
            reason = f"Fixed plan: {phase_name(self.phases[s.phase])} green ran its {num(g)} s, next is {phase_name(self.phases[to])}. It does not look at the queues."
            return Decision(to, "fixed", reason, self.phases[to])
        return Decision(None, "fixed", "Fixed plan holds.", self.phases[s.phase])


def _fairness_floor(p: Params, phases: list[list[int]], clearance: float) -> float:
    return p.fairnessCap - clearance - 2 - (len(phases) - 2) * (p.minGreen + clearance)


class VacController(Controller):
    kind = "vac"

    def __init__(self, cfg: SimConfig, phases: list[list[int]]) -> None:
        self.cfg = cfg
        self.phases = phases
        self.emergency_hold = 0

    def decide(self, view: View, p: Params) -> Decision:
        o = self.cfg.options
        s = view.signal
        phases = self.phases

        def nm(i: int) -> str:
            return phase_name(phases[i])

        cur_aps = phases[s.phase]
        if s.stage != "green":
            return Decision(None, "stay", "Clearance in progress.", cur_aps)
        clearance = p.yellow + p.allRed

        if view.emergency:
            target = next((i for i, aps in enumerate(phases) if view.emergency[0] in aps), -1)
            ap_name = view.names[view.emergency[0]]
            if target == s.phase:
                self.emergency_hold += 1
                if self.emergency_hold < 30:
                    return Decision(None, "emergency", f"Emergency vehicle approaching on {ap_name}. {nm(s.phase)} green is extended until it clears.", [view.emergency[0]])
            elif s.stage_t >= p.minGreen:
                self.emergency_hold = 0
                return Decision(
                    target,
                    "emergency",
                    f"Emergency vehicle on {ap_name}. Ending {nm(s.phase)} green after its minimum, through yellow and all-red, then serving {nm(target)}.",
                    [view.emergency[0]],
                )
            else:
                return Decision(None, "emergency", f"Emergency vehicle on {ap_name}. Waiting for the {num(p.minGreen)} s minimum green before switching.", [view.emergency[0]])
        else:
            self.emergency_hold = 0

        if o.fairnessGuard:
            worst, worst_red = -1, -1
            for ap in range(4):
                if ap in cur_aps:
                    continue
                if view.red[ap] > worst_red:
                    worst_red = view.red[ap]
                    worst = ap
            if worst >= 0 and worst_red >= _fairness_floor(p, phases, clearance):
                target = next((i for i, aps in enumerate(phases) if worst in aps), -1)
                return Decision(
                    target, "fairness", f"Fairness guard: {view.names[worst]} has had no green for {worst_red} s, cap is {num(p.fairnessCap)} s. Forcing {nm(target)}.", [worst]
                )

        def waiting(i: int) -> float:
            total = 0.0
            for ap in phases[i]:
                total += view.q[ap]
            return total

        def has_call(i: int) -> bool:
            return any(view.q_count[ap] > 0 or view.arr_soon[ap] > 0 for ap in phases[i])

        others = [i for i in range(len(phases)) if i != s.phase and has_call(i)]
        best, best_w = -1, -1.0
        for i in others:
            w = waiting(i) + 0.01 * max(view.red[ap] for ap in phases[i])
            if w > best_w:
                best_w = w
                best = i

        if s.stage_t >= p.maxGreen:
            if best >= 0:
                return Decision(best, "maxgreen", f"{nm(s.phase)} reached the {num(p.maxGreen)} s maximum green. {nm(best)} has {to_fixed(waiting(best), 1)} waiting. Switching.", phases[best])
            return Decision(None, "extend", f"{nm(s.phase)} is past its maximum green but nobody else is waiting, so it rests on green.", cur_aps)
        if s.stage_t < p.minGreen:
            return Decision(None, "mingreen", f"{nm(s.phase)} has run {s.stage_t} s of its {num(p.minGreen)} s minimum green.", cur_aps)

        if o.queueClearance and view.standing_left > 0:
            return Decision(
                None,
                "clearance",
                f"Clearing the {view.standing_left} of {view.standing_start} vehicles that were waiting when {nm(s.phase)} turned green. Vehicles that arrive later do not extend this green past the gap.",
                cur_aps,
            )

        cur_call = has_call(s.phase)
        if cur_call and best < 0:
            return Decision(
                None,
                "extend",
                f"Detectors still see vehicles on {nm(s.phase)} and nobody is waiting elsewhere. Extending the green, {num(p.maxGreen - s.stage_t)} s left before the maximum.",
                cur_aps,
            )
        if best >= 0:
            reason = (
                f"Gap-out: the {nm(s.phase)} queue that was standing has cleared and {nm(best)} has {to_fixed(waiting(best), 1)} waiting. Switching."
                if cur_call
                else f"Gap-out: no vehicles on {nm(s.phase)} and {nm(best)} has {to_fixed(waiting(best), 1)} waiting. Skipping the wasted green."
            )
            return Decision(best, "gapout", reason, phases[best])
        return Decision(None, "stay", "No vehicles waiting or arriving anywhere. Resting on green.", cur_aps)


@dataclass
class _PhaseEval:
    q: float
    e: float
    a: float
    score: float


@dataclass
class _Eval:
    phases: list[_PhaseEval] = field(default_factory=list)
    current: int = 0
    best: int = 0
    needed: float = 0.0


class SignalTwinController(Controller):
    kind = "signaltwin"

    def __init__(self, cfg: SimConfig, phases: list[list[int]]) -> None:
        self.cfg = cfg
        self.phases = phases
        self.emergency_hold = 0

    def evaluate(self, view: View, p: Params) -> _Eval:
        o = self.cfg.options
        rows: list[_PhaseEval] = []
        for aps in self.phases:
            q = e = a = 0.0
            for ap in aps:
                q += view.q[ap]
                e += p.beta * view.e[ap]
                a += p.gamma * view.red[ap] * view.lam[ap]
            rows.append(_PhaseEval(q, e, a, q + e + a))
        cur = view.signal.phase
        best = cur
        best_score = -math.inf
        for i, r in enumerate(rows):
            if i != cur and r.score > best_score:
                best_score = r.score
                best = i
        hyst = p.hysteresis if o.hysteresisOn else 0
        return _Eval(rows, cur, best, rows[cur].score * (1 + hyst))

    def decide(self, view: View, p: Params) -> Decision:
        o = self.cfg.options
        s = view.signal
        ev = self.evaluate(view, p)
        phases = self.phases

        def nm(i: int) -> str:
            return phase_name(phases[i])

        cur_aps = phases[s.phase]
        if s.stage != "green":
            return Decision(None, "stay", "Clearance in progress.", cur_aps)
        clearance = p.yellow + p.allRed

        if view.emergency:
            target = next((i for i, aps in enumerate(phases) if view.emergency[0] in aps), -1)
            ap_name = view.names[view.emergency[0]]
            if target == s.phase:
                self.emergency_hold += 1
                if self.emergency_hold < 30:
                    return Decision(None, "emergency", f"Emergency vehicle approaching on {ap_name}. {nm(s.phase)} green is extended until it clears.", [view.emergency[0]])
            elif s.stage_t >= p.minGreen:
                self.emergency_hold = 0
                return Decision(
                    target,
                    "emergency",
                    f"Emergency vehicle on {ap_name}. Ending {nm(s.phase)} green after its minimum, through yellow and all-red, then serving {nm(target)}.",
                    [view.emergency[0]],
                )
            else:
                return Decision(None, "emergency", f"Emergency vehicle on {ap_name}. Waiting for the {num(p.minGreen)} s minimum green before switching.", [view.emergency[0]])
        else:
            self.emergency_hold = 0

        if o.fairnessGuard:
            worst, worst_red = -1, -1
            for ap in range(4):
                if ap in cur_aps:
                    continue
                if view.red[ap] > worst_red:
                    worst_red = view.red[ap]
                    worst = ap
            if worst >= 0 and worst_red >= _fairness_floor(p, phases, clearance):
                target = next((i for i, aps in enumerate(phases) if worst in aps), -1)
                return Decision(
                    target, "fairness", f"Fairness guard: {view.names[worst]} has had no green for {worst_red} s, cap is {num(p.fairnessCap)} s. Forcing {nm(target)}.", [worst]
                )

        if s.stage_t >= p.maxGreen:
            return Decision(ev.best, "maxgreen", f"{nm(s.phase)} reached the {num(p.maxGreen)} s maximum green. Switching to {nm(ev.best)}.", phases[ev.best])

        if s.stage_t < p.minGreen:
            return Decision(None, "mingreen", f"{nm(s.phase)} has run {s.stage_t} s of its {num(p.minGreen)} s minimum green.", cur_aps)

        if o.queueClearance and view.standing_left > 0:
            return Decision(
                None,
                "clearance",
                f"Clearing the {view.standing_left} of {view.standing_start} vehicles that were waiting when {nm(s.phase)} turned green. The switch is not considered until they have left.",
                cur_aps,
            )

        cur = ev.phases[s.phase].score
        best_score = ev.phases[ev.best].score
        longest = max(view.red)
        if best_score > ev.needed + 1e-9:
            margin = js_round((best_score / cur - 1) * 100) if cur > 0 else 100
            need = js_round((p.hysteresis if o.hysteresisOn else 0) * 100)
            return Decision(
                ev.best,
                "switch",
                f"Switch to {nm(ev.best)}: pressure {to_fixed(best_score, 1)} vs {to_fixed(cur, 1)} on {nm(s.phase)} ({margin} percent higher, needs {need}). "
                f"Longest red now {longest} s, under the {num(p.fairnessCap)} s cap.",
                phases[ev.best],
            )
        return Decision(
            None,
            "stay",
            f"Hold {nm(s.phase)}: pressure {to_fixed(cur, 1)} vs {to_fixed(best_score, 1)} on {nm(ev.best)}, below the switch margin. Longest red {longest} s, under the {num(p.fairnessCap)} s cap.",
            cur_aps,
        )
