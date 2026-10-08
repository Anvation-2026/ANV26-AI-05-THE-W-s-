import {
  VEHICLE_CLASSES,
  type ControllerKind,
  type ControllerOptions,
  type DecisionEntry,
  type DemandProfile,
  type EmergencyEvent,
  type NoiseSpec,
  type ObservedTiming,
  type Params,
  type RuleKind,
  type VehicleClass,
} from '../contracts';
import { hash01, mulberry32, pickClass, poisson } from './rng';
import { phasesFor, phaseName } from './params';

export interface Veh {
  id: number;
  cls: VehicleClass;
  pcu: number;
  people: number;
  ap: number;
  arriveT: number; // crosses the upstream line
  etaQueue: number; // reaches the back of the queue
  queueT: number;
  departT: number;
  emergency: boolean;
  speed: number; // m/s between the upstream line and the stop line
}

export type Stage = 'green' | 'yellow' | 'allred';
export interface SignalState {
  phase: number;
  stage: Stage;
  stageT: number;
  next: number;
}

export interface PhaseEval {
  q: number;
  e: number;
  a: number;
  score: number;
}
export interface Eval {
  phases: PhaseEval[];
  current: number;
  best: number;
  needed: number; // score the best candidate must beat
  rule: RuleKind;
  reason: string;
  objective: 'vehicles' | 'people';
}

export interface View {
  t: number;
  signal: SignalState;
  phases: number[][];
  q: number[];
  e: number[];
  red: number[];
  lambda: number[];
  emergency: number[];
  names: string[];
  /** Vehicles waiting in each queue zone, as the detectors see them. */
  qCount: number[];
  /** Vehicles about to reach each queue within the passage time. */
  arrSoon: number[];
  /** Vehicles that were in the queue zone when this green started and have not left yet. */
  standingLeft: number;
  standingStart: number;
}

export interface Decision {
  switchTo: number | null;
  rule: RuleKind;
  reason: string;
  approaches: number[];
  eval?: Eval;
}

export interface Controller {
  kind: ControllerKind;
  decide(view: View, p: Params): Decision;
  lastEval: Eval | null;
  lastReason: string;
  lastRule: RuleKind;
}

export interface SimConfig {
  params: Params;
  demand: DemandProfile;
  kind: ControllerKind;
  options: ControllerOptions;
  seed: number;
  horizon: number;
  noise: NoiseSpec;
  emergencies: EmergencyEvent[];
  observed: ObservedTiming;
  websterGreens?: number[];
  names?: string[];
  record?: boolean;
}

export interface DepartRec {
  t: number;
  ap: number;
  cls: VehicleClass;
  pcu: number;
  sat: boolean;
}
export interface ArriveRec {
  t: number;
  ap: number;
  cls: VehicleClass;
}

const AP_NAMES = ['North', 'South', 'East', 'West'];

export function buildArrivals(cfg: SimConfig): Veh[][] {
  const { params, demand, horizon } = cfg;
  const out: Veh[][] = Array.from({ length: horizon + 1 }, () => []);
  let id = 1;
  for (let ap = 0; ap < 4; ap++) {
    const rng = mulberry32(cfg.seed * 7919 + ap * 104729 + 17);
    const rates = demand.rates[ap];
    const mix = demand.mix[ap];
    for (let t = 0; t < horizon; t++) {
      const bin = Math.min(rates.length - 1, Math.floor(t / demand.binSeconds));
      const n = poisson(rng, rates[bin]);
      for (let i = 0; i < n; i++) {
        const cls = pickClass(rng, mix, VEHICLE_CLASSES);
        const travel = params.travelMin + rng() * (params.travelMax - params.travelMin);
        const spec = params.classes[cls];
        out[t].push({
          id: id++,
          cls,
          pcu: spec.pcu,
          people: spec.people,
          ap,
          arriveT: t,
          etaQueue: t + Math.max(1, Math.round(travel)),
          queueT: -1,
          departT: -1,
          emergency: false,
          speed: 50 / travel,
        });
      }
    }
  }
  let k = 0;
  for (const ev of cfg.emergencies) {
    if (ev.t < 0 || ev.t >= horizon) continue;
    const spec = params.classes.car;
    out[ev.t].push({
      id: 9_000_000 + k++,
      cls: 'car',
      pcu: spec.pcu,
      people: 3,
      ap: ev.approach,
      arriveT: ev.t,
      etaQueue: ev.t + 8,
      queueT: -1,
      departT: -1,
      emergency: true,
      speed: 50 / 8,
    });
  }
  return out;
}

export class Sim {
  cfg: SimConfig;
  params: Params;
  phases: number[][];
  t = 0;
  arrivals: Veh[][];
  transit: Veh[][] = [[], [], [], []];
  queue: Veh[][] = [[], [], [], []];
  recentDeparted: { v: Veh; t: number }[][] = [[], [], [], []];
  accum = [0, 0, 0, 0];
  signal: SignalState;
  red = [0, 0, 0, 0];
  maxRed = [0, 0, 0, 0];
  lambda = [0, 0, 0, 0];
  waits: number[] = [];
  waitSum = [0, 0, 0, 0];
  waitCount = [0, 0, 0, 0];
  peopleWait = 0;
  peopleCount = 0;
  served = 0;
  servedPeople = 0;
  maxQueue = [0, 0, 0, 0];
  decisions: DecisionEntry[] = [];
  controller: Controller;
  qSeries: number[][] = [[], [], [], []];
  lampSeries: number[][] = [[], [], [], []]; // 0 red, 1 yellow, 2 green
  redSeries: number[][] = [[], [], [], []];
  phaseSeries: number[] = [];
  arriveRec: ArriveRec[] = [];
  departRec: DepartRec[] = [];
  greenStarts: { t: number; phase: number }[] = [];
  emergencyOutstanding = 0;
  emergencyDelayCost = 0;
  lastHoldLogT = -100;
  names: string[];
  /** Ids of the vehicles that were waiting in the queue zones when the current green began. */
  standing: Set<number> = new Set();
  standingStart = 0;

  constructor(cfg: SimConfig) {
    this.cfg = cfg;
    this.params = cfg.params;
    this.phases = phasesFor(cfg.params.fourPhase);
    this.names = cfg.names ?? AP_NAMES;
    this.arrivals = buildArrivals(cfg);
    this.signal = { phase: 0, stage: 'green', stageT: 0, next: 0 };
    this.greenStarts.push({ t: 0, phase: 0 });
    this.controller = createController(cfg, this.phases);
  }

  /** Add an emergency vehicle that crosses the upstream line next second. */
  injectEmergency(approach: number): void {
    const t = Math.min(this.t, this.cfg.horizon - 1);
    const spec = this.params.classes.car;
    const k = this.arrivals.reduce((n, a) => n + a.filter((v) => v.emergency).length, 0);
    (this.arrivals[t] ??= []).push({
      id: 9_100_000 + k,
      cls: 'car',
      pcu: spec.pcu,
      people: 3,
      ap: approach,
      arriveT: t,
      etaQueue: t + 8,
      queueT: -1,
      departT: -1,
      emergency: true,
      speed: 50 / 8,
    });
  }

  /** What the controller is allowed to see, after detection noise. */
  buildView(): View {
    const { options, noise, params } = this.cfg;
    const seed = this.cfg.seed;
    const people = options.objective === 'people';
    const w = (cls: VehicleClass): number => {
      const spec = params.classes[cls];
      return people ? spec.people : options.pcuWeighting ? spec.pcu : 1;
    };
    const q = [0, 0, 0, 0];
    const e = [0, 0, 0, 0];
    const qCount = [0, 0, 0, 0];
    const arrSoon = [0, 0, 0, 0];
    let standingLeft = 0;
    const seen = (v: Veh): VehicleClass | null => {
      if (v.emergency) return v.cls;
      if (noise.missRate > 0 && hash01(v.id * 31 + seed) < noise.missRate) return null;
      if (noise.labelError > 0 && hash01(v.id * 17 + seed + 5) < noise.labelError) return 'car';
      return v.cls;
    };
    const emergency: number[] = [];
    const curAps = this.phases[this.signal.phase];
    for (let ap = 0; ap < 4; ap++) {
      for (const v of this.queue[ap]) {
        const c = seen(v);
        if (c) {
          q[ap] += w(c);
          qCount[ap]++;
          if (curAps.includes(ap) && this.standing.has(v.id)) standingLeft++;
        }
        if (v.emergency) emergency.push(ap);
      }
      for (const v of this.transit[ap]) {
        if (v.emergency) {
          emergency.push(ap);
          continue;
        }
        const c = seen(v);
        if (!c) continue;
        if (this.t - v.arriveT < noise.delaySec) continue;
        if (options.lookahead && v.etaQueue - this.t <= params.lookaheadH + 2) e[ap] += w(c);
        if (v.etaQueue - this.t <= params.vacGap) arrSoon[ap]++;
      }
    }
    return {
      qCount,
      arrSoon,
      standingLeft,
      standingStart: this.standingStart,
      t: this.t,
      signal: this.signal,
      phases: this.phases,
      q,
      e,
      red: this.red,
      lambda: this.lambda,
      emergency: options.emergencyPriority ? Array.from(new Set(emergency)) : [],
      names: this.names,
    };
  }

  step(): void {
    const t = this.t;
    const p = this.params;
    const { options, noise } = this.cfg;
    const people = options.objective === 'people';

    // 1. arrivals cross the upstream line
    const arr = this.arrivals[t] ?? [];
    const arrW = [0, 0, 0, 0];
    for (const v0 of arr) {
      const v: Veh = { ...v0 };
      this.transit[v.ap].push(v);
      if (v.emergency) this.emergencyOutstanding++;
      if (this.cfg.record) this.arriveRec.push({ t, ap: v.ap, cls: v.cls });
      const vis = v.emergency || !(noise.missRate > 0 && hash01(v.id * 31 + this.cfg.seed) < noise.missRate);
      if (vis) arrW[v.ap] += people ? v.people : options.pcuWeighting ? v.pcu : 1;
    }
    for (let ap = 0; ap < 4; ap++) this.lambda[ap] = this.lambda[ap] * 0.98 + arrW[ap] * 0.02;

    // 2. transit to queue
    for (let ap = 0; ap < 4; ap++) {
      const tr = this.transit[ap];
      if (tr.length) {
        const still: Veh[] = [];
        const ready: Veh[] = [];
        for (const v of tr) (v.etaQueue <= t ? ready : still).push(v);
        if (ready.length) {
          ready.sort((a, b) => a.etaQueue - b.etaQueue || a.id - b.id);
          for (const v of ready) {
            v.queueT = t;
            this.queue[ap].push(v);
          }
          this.transit[ap] = still;
        }
      }
    }

    // 3. controller decision (only when green)
    const view = this.buildView();
    const dec = this.controller.decide(view, p);
    if (this.signal.stage === 'green') {
      if (dec.switchTo !== null && dec.switchTo !== this.signal.phase) {
        this.decisions.push({
          t,
          rule: dec.rule,
          from: this.signal.phase,
          to: dec.switchTo,
          action: `Switch to ${phaseName(this.phases[dec.switchTo])}`,
          reason: dec.reason,
          approaches: dec.approaches,
        });
        this.signal = { phase: this.signal.phase, stage: 'yellow', stageT: 0, next: dec.switchTo };
      } else if (
        (this.cfg.kind === 'signaltwin' || this.cfg.kind === 'vac') &&
        t - this.lastHoldLogT >= 10 &&
        (dec.rule === 'emergency' || dec.rule === 'clearance' || dec.rule === 'extend' || (dec.rule === 'stay' && this.signal.stageT >= p.minGreen))
      ) {
        this.lastHoldLogT = t;
        const ph = phaseName(this.phases[this.signal.phase]);
        this.decisions.push({
          t,
          rule: dec.rule,
          from: this.signal.phase,
          to: this.signal.phase,
          action:
            dec.rule === 'emergency'
              ? `Hold ${ph} green for emergency vehicle`
              : dec.rule === 'clearance'
                ? `Clear the ${ph} queue`
                : dec.rule === 'extend'
                  ? `Extend ${ph} green`
                  : `Hold ${ph} green`,
          reason: dec.reason,
          approaches: dec.approaches,
        });
      }
    }

    // 4. discharge
    const sat = (p.satFlowPerLane * p.lanes) / 3600; // PCU per second
    const phaseAps = this.phases[this.signal.phase];
    const flowing =
      this.signal.stage === 'yellow' || (this.signal.stage === 'green' && this.signal.stageT >= p.startupLost);
    for (let ap = 0; ap < 4; ap++) {
      const active = flowing && phaseAps.includes(ap);
      if (!active) {
        this.accum[ap] = 0;
        continue;
      }
      const q = this.queue[ap];
      if (q.length === 0) {
        this.accum[ap] = 0;
        continue;
      }
      this.accum[ap] += sat;
      while (q.length && this.accum[ap] >= q[0].pcu - 1e-9) {
        const v = q.shift() as Veh;
        this.accum[ap] -= v.pcu;
        v.departT = t;
        const wait = t - v.queueT;
        this.waits.push(wait);
        this.waitSum[ap] += wait;
        this.waitCount[ap]++;
        this.peopleWait += wait * v.people;
        this.peopleCount += v.people;
        this.served++;
        this.servedPeople += v.people;
        this.recentDeparted[ap].push({ v, t });
        if (v.emergency) this.emergencyOutstanding = Math.max(0, this.emergencyOutstanding - 1);
        if (this.cfg.record) this.departRec.push({ t, ap, cls: v.cls, pcu: v.pcu, sat: q.length > 0 });
      }
    }
    for (let ap = 0; ap < 4; ap++) {
      const rd = this.recentDeparted[ap];
      while (rd.length && t - rd[0].t > 9) rd.shift();
    }

    // 5. accounting
    for (let ap = 0; ap < 4; ap++) {
      let qp = 0;
      for (const v of this.queue[ap]) qp += v.pcu;
      this.qSeries[ap].push(qp);
      if (qp > this.maxQueue[ap]) this.maxQueue[ap] = qp;
      const served = phaseAps.includes(ap) && this.signal.stage !== 'allred';
      if (served) this.red[ap] = 0;
      else this.red[ap]++;
      if (this.red[ap] > this.maxRed[ap]) this.maxRed[ap] = this.red[ap];
      let lamp = 0;
      if (phaseAps.includes(ap)) {
        if (this.signal.stage === 'green') lamp = 2;
        else if (this.signal.stage === 'yellow') lamp = 1;
      }
      this.lampSeries[ap].push(lamp);
      this.redSeries[ap].push(this.red[ap]);
    }
    this.phaseSeries.push(this.signal.phase);
    if (this.emergencyOutstanding > 0) {
      for (let ap = 0; ap < 4; ap++) {
        if (!view.emergency.includes(ap)) this.emergencyDelayCost += this.queue[ap].length;
      }
    }

    // 6. advance the signal clock
    const s = this.signal;
    s.stageT++;
    if (s.stage === 'yellow' && s.stageT >= p.yellow) {
      s.stage = 'allred';
      s.stageT = 0;
    } else if (s.stage === 'allred' && s.stageT >= p.allRed) {
      s.phase = s.next;
      s.stage = 'green';
      s.stageT = 0;
      this.greenStarts.push({ t: t + 1, phase: s.phase });
      // remember who was waiting in the queue zones at the moment this green began
      this.standing = new Set(this.phases[s.phase].flatMap((ap) => this.queue[ap].map((v) => v.id)));
      this.standingStart = this.standing.size;
    }
    this.t++;
  }

  run(until = this.cfg.horizon): this {
    while (this.t < until) this.step();
    return this;
  }
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

function createController(cfg: SimConfig, phases: number[][]): Controller {
  if (cfg.kind === 'signaltwin') return new SignalTwinController(cfg, phases);
  if (cfg.kind === 'vac') return new VacController(cfg, phases);
  const greens =
    cfg.kind === 'webster' && cfg.websterGreens
      ? cfg.websterGreens
      : padGreens(cfg.observed.greens, phases.length, cfg.params.minGreen);
  return new FixedController(cfg.kind, greens, phases);
}

function padGreens(g: number[], n: number, fallback: number): number[] {
  const out = g.slice(0, n);
  while (out.length < n) out.push(Math.max(fallback, g[out.length % Math.max(1, g.length)] ?? fallback));
  return out;
}

class FixedController implements Controller {
  lastEval: Eval | null = null;
  lastReason = 'Fixed plan holds.';
  lastRule: RuleKind = 'fixed';
  constructor(
    public kind: ControllerKind,
    private greens: number[],
    private phases: number[][],
  ) {}
  decide(view: View): Decision {
    const s = view.signal;
    const g = this.greens[s.phase];
    if (s.stage === 'green' && s.stageT >= g) {
      const to = (s.phase + 1) % this.phases.length;
      const reason = `Fixed plan: ${phaseName(this.phases[s.phase])} green ran its ${g} s, next is ${phaseName(this.phases[to])}. It does not look at the queues.`;
      this.lastReason = reason;
      return { switchTo: to, rule: 'fixed', reason, approaches: this.phases[to] };
    }
    return { switchTo: null, rule: 'fixed', reason: 'Fixed plan holds.', approaches: this.phases[s.phase] };
  }
}

/**
 * Vehicle-actuated control (VAC), the standard detector-based logic.
 * - A phase with no calls is skipped.
 * - Green is held until the vehicles that were standing in the queue zone when it started have left.
 * - After that it is extended only while detectors keep seeing vehicles and nobody else is waiting.
 * - When the road empties, or another road is waiting and the gap is longer than the passage time, it gaps out.
 * - Maximum green always ends it, and the emergency and fairness rules still apply.
 */
class VacController implements Controller {
  kind: ControllerKind = 'vac';
  lastEval: Eval | null = null;
  lastReason = '';
  lastRule: RuleKind = 'stay';
  private emergencyHold = 0;
  constructor(
    private cfg: SimConfig,
    private phases: number[][],
  ) {}

  decide(view: View, p: Params): Decision {
    const o = this.cfg.options;
    const s = view.signal;
    const nm = (i: number) => phaseName(this.phases[i]);
    const curAps = this.phases[s.phase];
    const done = (d: Decision): Decision => {
      this.lastReason = d.reason;
      this.lastRule = d.rule;
      return d;
    };
    if (s.stage !== 'green') return done({ switchTo: null, rule: 'stay', reason: 'Clearance in progress.', approaches: curAps });
    const clearance = p.yellow + p.allRed;

    // emergency priority, same behaviour as the SignalTwin plan
    if (view.emergency.length) {
      const target = this.phases.findIndex((aps) => aps.includes(view.emergency[0]));
      const apName = view.names[view.emergency[0]];
      if (target === s.phase) {
        this.emergencyHold++;
        if (this.emergencyHold < 30) {
          return done({ switchTo: null, rule: 'emergency', reason: `Emergency vehicle approaching on ${apName}. ${nm(s.phase)} green is extended until it clears.`, approaches: [view.emergency[0]] });
        }
      } else if (s.stageT >= p.minGreen) {
        this.emergencyHold = 0;
        return done({ switchTo: target, rule: 'emergency', reason: `Emergency vehicle on ${apName}. Ending ${nm(s.phase)} green after its minimum, through yellow and all-red, then serving ${nm(target)}.`, approaches: [view.emergency[0]] });
      } else {
        return done({ switchTo: null, rule: 'emergency', reason: `Emergency vehicle on ${apName}. Waiting for the ${p.minGreen} s minimum green before switching.`, approaches: [view.emergency[0]] });
      }
    } else {
      this.emergencyHold = 0;
    }

    // hard fairness guard
    if (o.fairnessGuard) {
      let worst = -1;
      let worstRed = -1;
      for (let ap = 0; ap < 4; ap++) {
        if (curAps.includes(ap)) continue;
        if (view.red[ap] > worstRed) {
          worstRed = view.red[ap];
          worst = ap;
        }
      }
      if (worst >= 0 && worstRed >= p.fairnessCap - clearance - 2 - (this.phases.length - 2) * (p.minGreen + clearance)) {
        const target = this.phases.findIndex((aps) => aps.includes(worst));
        return done({ switchTo: target, rule: 'fairness', reason: `Fairness guard: ${view.names[worst]} has had no green for ${worstRed} s, cap is ${p.fairnessCap} s. Forcing ${nm(target)}.`, approaches: [worst] });
      }
    }

    const waiting = (i: number) => this.phases[i].reduce((sum, ap) => sum + view.q[ap], 0);
    const hasCall = (i: number) => this.phases[i].some((ap) => view.qCount[ap] > 0 || view.arrSoon[ap] > 0);
    const others = this.phases.map((_, i) => i).filter((i) => i !== s.phase && hasCall(i));
    let best = -1;
    let bestW = -1;
    for (const i of others) {
      const w = waiting(i) + 0.01 * Math.max(...this.phases[i].map((ap) => view.red[ap]));
      if (w > bestW) {
        bestW = w;
        best = i;
      }
    }

    if (s.stageT >= p.maxGreen) {
      if (best >= 0) return done({ switchTo: best, rule: 'maxgreen', reason: `${nm(s.phase)} reached the ${p.maxGreen} s maximum green. ${nm(best)} has ${waiting(best).toFixed(1)} waiting. Switching.`, approaches: this.phases[best] });
      return done({ switchTo: null, rule: 'extend', reason: `${nm(s.phase)} is past its maximum green but nobody else is waiting, so it rests on green.`, approaches: curAps });
    }
    if (s.stageT < p.minGreen) return done({ switchTo: null, rule: 'mingreen', reason: `${nm(s.phase)} has run ${s.stageT} s of its ${p.minGreen} s minimum green.`, approaches: curAps });

    if (o.queueClearance && view.standingLeft > 0) {
      return done({
        switchTo: null,
        rule: 'clearance',
        reason: `Clearing the ${view.standingLeft} of ${view.standingStart} vehicles that were waiting when ${nm(s.phase)} turned green. Vehicles that arrive later do not extend this green past the gap.`,
        approaches: curAps,
      });
    }

    const curCall = hasCall(s.phase);
    if (curCall && best < 0) {
      return done({ switchTo: null, rule: 'extend', reason: `Detectors still see vehicles on ${nm(s.phase)} and nobody is waiting elsewhere. Extending the green, ${p.maxGreen - s.stageT} s left before the maximum.`, approaches: curAps });
    }
    if (best >= 0) {
      return done({
        switchTo: best,
        rule: 'gapout',
        reason: curCall
          ? `Gap-out: the ${nm(s.phase)} queue that was standing has cleared and ${nm(best)} has ${waiting(best).toFixed(1)} waiting. Switching.`
          : `Gap-out: no vehicles on ${nm(s.phase)} and ${nm(best)} has ${waiting(best).toFixed(1)} waiting. Skipping the wasted green.`,
        approaches: this.phases[best],
      });
    }
    return done({ switchTo: null, rule: 'stay', reason: 'No vehicles waiting or arriving anywhere. Resting on green.', approaches: curAps });
  }
}

class SignalTwinController implements Controller {
  kind: ControllerKind = 'signaltwin';
  lastEval: Eval | null = null;
  lastReason = '';
  lastRule: RuleKind = 'stay';
  private emergencyHold = 0;
  constructor(
    private cfg: SimConfig,
    private phases: number[][],
  ) {}

  evaluate(view: View, p: Params): Eval {
    const o = this.cfg.options;
    const rows: PhaseEval[] = this.phases.map((aps) => {
      let q = 0,
        e = 0,
        a = 0;
      for (const ap of aps) {
        q += view.q[ap];
        e += p.beta * view.e[ap];
        a += p.gamma * view.red[ap] * view.lambda[ap];
      }
      return { q, e, a, score: q + e + a };
    });
    const cur = view.signal.phase;
    let best = cur;
    let bestScore = -Infinity;
    rows.forEach((r, i) => {
      if (i !== cur && r.score > bestScore) {
        bestScore = r.score;
        best = i;
      }
    });
    const hyst = o.hysteresisOn ? p.hysteresis : 0;
    return {
      phases: rows,
      current: cur,
      best,
      needed: rows[cur].score * (1 + hyst),
      rule: 'stay',
      reason: '',
      objective: o.objective,
    };
  }

  decide(view: View, p: Params): Decision {
    const o = this.cfg.options;
    const s = view.signal;
    const ev = this.evaluate(view, p);
    this.lastEval = ev;
    const nm = (i: number) => phaseName(this.phases[i]);
    const fmt = (n: number) => n.toFixed(1);
    const curAps = this.phases[s.phase];
    const done = (d: Omit<Decision, 'eval'>): Decision => {
      ev.rule = d.rule;
      ev.reason = d.reason;
      this.lastReason = d.reason;
      this.lastRule = d.rule;
      return { ...d, eval: ev };
    };
    if (s.stage !== 'green') {
      return done({ switchTo: null, rule: 'stay', reason: 'Clearance in progress.', approaches: curAps });
    }
    const clearance = p.yellow + p.allRed;

    // emergency priority
    if (view.emergency.length) {
      const target = this.phases.findIndex((aps) => aps.includes(view.emergency[0]));
      const apName = view.names[view.emergency[0]];
      if (target === s.phase) {
        this.emergencyHold++;
        if (this.emergencyHold < 30) {
          return done({
            switchTo: null,
            rule: 'emergency',
            reason: `Emergency vehicle approaching on ${apName}. ${nm(s.phase)} green is extended until it clears.`,
            approaches: [view.emergency[0]],
          });
        }
      } else if (s.stageT >= p.minGreen) {
        this.emergencyHold = 0;
        return done({
          switchTo: target,
          rule: 'emergency',
          reason: `Emergency vehicle on ${apName}. Ending ${nm(s.phase)} green after its minimum, through yellow and all-red, then serving ${nm(target)}.`,
          approaches: [view.emergency[0]],
        });
      } else {
        return done({
          switchTo: null,
          rule: 'emergency',
          reason: `Emergency vehicle on ${apName}. Waiting for the ${p.minGreen} s minimum green before switching.`,
          approaches: [view.emergency[0]],
        });
      }
    } else {
      this.emergencyHold = 0;
    }

    // hard fairness guard
    if (o.fairnessGuard) {
      let worst = -1;
      let worstRed = -1;
      for (let ap = 0; ap < 4; ap++) {
        if (curAps.includes(ap)) continue;
        if (view.red[ap] > worstRed) {
          worstRed = view.red[ap];
          worst = ap;
        }
      }
      if (worst >= 0 && worstRed >= p.fairnessCap - clearance - 2 - (this.phases.length - 2) * (p.minGreen + clearance)) {
        const target = this.phases.findIndex((aps) => aps.includes(worst));
        return done({
          switchTo: target,
          rule: 'fairness',
          reason: `Fairness guard: ${view.names[worst]} has had no green for ${worstRed} s, cap is ${p.fairnessCap} s. Forcing ${nm(target)}.`,
          approaches: [worst],
        });
      }
    }

    // max green
    if (s.stageT >= p.maxGreen) {
      return done({
        switchTo: ev.best,
        rule: 'maxgreen',
        reason: `${nm(s.phase)} reached the ${p.maxGreen} s maximum green. Switching to ${nm(ev.best)}.`,
        approaches: this.phases[ev.best],
      });
    }

    // minimum green
    if (s.stageT < p.minGreen) {
      return done({
        switchTo: null,
        rule: 'mingreen',
        reason: `${nm(s.phase)} has run ${s.stageT} s of its ${p.minGreen} s minimum green.`,
        approaches: curAps,
      });
    }

    // clear the vehicles that were standing in the queue zone when this green began
    if (o.queueClearance && view.standingLeft > 0) {
      return done({
        switchTo: null,
        rule: 'clearance',
        reason: `Clearing the ${view.standingLeft} of ${view.standingStart} vehicles that were waiting when ${nm(s.phase)} turned green. The switch is not considered until they have left.`,
        approaches: curAps,
      });
    }

    const cur = ev.phases[s.phase].score;
    const bestScore = ev.phases[ev.best].score;
    if (bestScore > ev.needed + 1e-9) {
      const margin = cur > 0 ? Math.round((bestScore / cur - 1) * 100) : 100;
      return done({
        switchTo: ev.best,
        rule: 'switch',
        reason: `Switch to ${nm(ev.best)}: pressure ${fmt(bestScore)} vs ${fmt(cur)} on ${nm(s.phase)} (${margin} percent higher, needs ${Math.round((o.hysteresisOn ? p.hysteresis : 0) * 100)}). Longest red now ${Math.max(...view.red)} s, under the ${p.fairnessCap} s cap.`,
        approaches: this.phases[ev.best],
      });
    }
    return done({
      switchTo: null,
      rule: 'stay',
      reason: `Hold ${nm(s.phase)}: pressure ${fmt(cur)} vs ${fmt(bestScore)} on ${nm(ev.best)}, below the switch margin. Longest red ${Math.max(...view.red)} s, under the ${p.fairnessCap} s cap.`,
      approaches: curAps,
    });
  }
}

