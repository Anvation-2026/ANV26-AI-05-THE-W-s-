import {
  VEHICLE_CLASSES,
  type CountsRow,
  type DemandProfile,
  type Params,
  type Scenario,
  type VehicleClass,
} from '../contracts';
import { phasesFor } from './params';
import { APPROACHES } from '../contracts';
import type { ArriveRec, DepartRec } from './sim';

type Mix = Record<VehicleClass, number>;

const mix = (twoWheeler: number, car: number, autoRickshaw: number, bus: number, truck: number): Mix => ({
  twoWheeler,
  car,
  autoRickshaw,
  bus,
  truck,
});

/** Mean PCU per second the sample junction receives on each approach (N, S, E, W). */
export const BASE_PCU_RATES = [0.34, 0.3, 0.3, 0.26];
export const BASE_MIX: Mix[] = [mix(0.34, 0.42, 0.12, 0.06, 0.06), mix(0.38, 0.4, 0.12, 0.05, 0.05), mix(0.32, 0.44, 0.12, 0.06, 0.06), mix(0.4, 0.38, 0.12, 0.05, 0.05)];

export function avgPcu(m: Mix, p: Params): number {
  return VEHICLE_CLASSES.reduce((s, c) => s + m[c] * p.classes[c].pcu, 0);
}
export function avgPeople(m: Mix, p: Params): number {
  return VEHICLE_CLASSES.reduce((s, c) => s + m[c] * p.classes[c].people, 0);
}
export function satPcuPerSec(p: Params): number {
  return (p.satFlowPerLane * p.lanes) / 3600;
}

export function binsFor(horizon: number, binSeconds: number): number {
  return Math.max(1, Math.ceil(horizon / binSeconds));
}

/** The sample junction's base demand, with a slow natural swing. Vehicles per second. */
export function baseProfile(p: Params, horizon = p.horizon): DemandProfile {
  const bins = binsFor(horizon, p.binSeconds);
  const rates = BASE_PCU_RATES.map((pcu, ap) => {
    const mean = pcu / avgPcu(BASE_MIX[ap], p);
    return Array.from({ length: bins }, (_, b) => {
      const t = (b + 0.5) * p.binSeconds;
      return Math.max(0, mean * (1 + 0.12 * Math.sin((2 * Math.PI * t) / 540 + ap * 1.3)));
    });
  });
  return { binSeconds: p.binSeconds, duration: horizon, rates, mix: BASE_MIX.map((m) => ({ ...m })) };
}

export function meanPcuRates(profile: DemandProfile, p: Params): number[] {
  return profile.rates.map((r, ap) => {
    const mean = r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
    return mean * avgPcu(profile.mix[ap], p);
  });
}

/** Flow ratio per phase: the busiest approach's PCU rate over saturation flow. */
export function phaseFlowRatios(pcuRates: number[], p: Params): number[] {
  const s = satPcuPerSec(p);
  return phasesFor(p.fourPhase).map((aps) => Math.max(...aps.map((a) => pcuRates[a])) / s);
}

export function scenarioProfile(base: DemandProfile, sc: Scenario, p: Params, horizon = p.horizon): DemandProfile {
  const bins = binsFor(horizon, base.binSeconds);
  const baseMeans = meanPcuRates(base, p);
  const y = phaseFlowRatios(baseMeans, p).reduce((a, b) => a + b, 0);
  const k = y > 0 ? sc.targetY / y : 1;
  const rates = base.rates.map((r, ap) =>
    Array.from({ length: bins }, (_, b) => {
      const t = (b + 0.5) * base.binSeconds;
      let v = r[Math.min(r.length - 1, b)] * k * (sc.multipliers[ap] ?? 1);
      for (const s of sc.surges) if (s.approach === ap && t >= s.from && t < s.to) v *= s.mult;
      return v;
    }),
  );
  return { ...base, duration: horizon, rates, mix: base.mix.map((m) => ({ ...m })) };
}

export interface WebsterPlan {
  cycle: number;
  greens: number[];
  y: number[];
  Y: number;
  lost: number;
  overCapacity: boolean;
  note: string;
}

/** Webster fixed-time plan from the busiest minute of measured demand. */
export function websterPlan(profile: DemandProfile, p: Params): WebsterPlan {
  const phases = phasesFor(p.fourPhase);
  const win = Math.max(1, Math.round(60 / profile.binSeconds));
  const peaks = profile.rates.map((r, ap) => {
    let best = 0;
    for (let i = 0; i + win <= r.length; i++) {
      let s = 0;
      for (let j = 0; j < win; j++) s += r[i + j];
      best = Math.max(best, s / win);
    }
    if (r.length < win) best = r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
    return best * avgPcu(profile.mix[ap], p);
  });
  const s = satPcuPerSec(p);
  const y = phases.map((aps) => Math.max(...aps.map((a) => peaks[a])) / s);
  const Y = y.reduce((a, b) => a + b, 0);
  const lost = phases.length * (p.startupLost + p.yellow + p.allRed);
  const overCapacity = Y >= 0.9;
  const Yc = Math.min(Y, 0.9);
  const C0 = Math.min(120, Math.max(30, (1.5 * lost + 5) / (1 - Yc)));
  const greens = y.map((yi) => {
    const eff = ((C0 - lost) * yi) / Math.max(1e-6, Y);
    return Math.max(p.minGreen, Math.min(p.maxGreen, Math.round(eff + p.startupLost - p.yellow)));
  });
  return {
    cycle: Math.round(greens.reduce((a, b) => a + b, 0) + phases.length * (p.yellow + p.allRed)),
    greens,
    y,
    Y,
    lost,
    overCapacity,
    note: overCapacity
      ? 'Peak demand is at or over capacity (Y of 0.9 or more). The formula breaks down here, so the cycle is capped at 120 s. A fixed plan cannot absorb this.'
      : 'Computed from the busiest minute of measured demand.',
  };
}

// ---------------------------------------------------------------------------
// Estimating demand from counts (what the perception module will emit)
// ---------------------------------------------------------------------------

export interface BinnedCounts {
  binSeconds: number;
  bins: number;
  counts: number[][][]; // [approach][bin][classIndex]
}

export function binArrivals(recs: ArriveRec[], duration: number, binSeconds: number): BinnedCounts {
  const bins = binsFor(duration, binSeconds);
  const counts = Array.from({ length: 4 }, () => Array.from({ length: bins }, () => VEHICLE_CLASSES.map(() => 0)));
  for (const r of recs) {
    const b = Math.min(bins - 1, Math.floor(r.t / binSeconds));
    counts[r.ap][b][VEHICLE_CLASSES.indexOf(r.cls)]++;
  }
  return { binSeconds, bins, counts };
}

export function binCountsCsv(rows: CountsRow[], binSeconds: number): { binned: BinnedCounts; duration: number } {
  const duration = rows.reduce((m, r) => Math.max(m, r.t), 0) + binSeconds;
  const bins = binsFor(duration, binSeconds);
  const counts = Array.from({ length: 4 }, () => Array.from({ length: bins }, () => VEHICLE_CLASSES.map(() => 0)));
  for (const r of rows) {
    const ap = APPROACHES.indexOf(r.approach);
    if (ap < 0) continue;
    const b = Math.min(bins - 1, Math.floor(r.t / binSeconds));
    counts[ap][b][VEHICLE_CLASSES.indexOf(r.cls)] += r.count;
  }
  return { binned: { binSeconds, bins, counts }, duration };
}

export interface EstimatedDemand {
  profile: DemandProfile;
  rawPcu: number[][]; // [approach][bin] PCU per second, unsmoothed
  smoothPcu: number[][];
  rawVeh: number[][];
  totals: number[]; // vehicles per approach
}

export function estimateDemand(b: BinnedCounts, p: Params, alpha = p.smoothing): EstimatedDemand {
  const rawVeh: number[][] = [];
  const rawPcu: number[][] = [];
  const smoothVeh: number[][] = [];
  const smoothPcu: number[][] = [];
  const mixes: Mix[] = [];
  const totals: number[] = [];
  for (let ap = 0; ap < 4; ap++) {
    const rv: number[] = [];
    const rp: number[] = [];
    const cls = VEHICLE_CLASSES.map(() => 0);
    for (let bin = 0; bin < b.bins; bin++) {
      const c = b.counts[ap][bin];
      const n = c.reduce((s, x) => s + x, 0);
      const pcu = c.reduce((s, x, i) => s + x * p.classes[VEHICLE_CLASSES[i]].pcu, 0);
      rv.push(n / b.binSeconds);
      rp.push(pcu / b.binSeconds);
      c.forEach((x, i) => (cls[i] += x));
    }
    const sv: number[] = [];
    const sp: number[] = [];
    rv.forEach((v, i) => {
      sv.push(i === 0 ? v : alpha * v + (1 - alpha) * sv[i - 1]);
      sp.push(i === 0 ? rp[i] : alpha * rp[i] + (1 - alpha) * sp[i - 1]);
    });
    const tot = cls.reduce((s, x) => s + x, 0);
    totals.push(tot);
    const m = {} as Mix;
    VEHICLE_CLASSES.forEach((c, i) => (m[c] = tot > 0 ? cls[i] / tot : 1 / VEHICLE_CLASSES.length));
    mixes.push(m);
    rawVeh.push(rv);
    rawPcu.push(rp);
    smoothVeh.push(sv);
    smoothPcu.push(sp);
  }
  return {
    profile: { binSeconds: b.binSeconds, duration: b.bins * b.binSeconds, rates: smoothVeh, mix: mixes },
    rawPcu,
    smoothPcu,
    rawVeh,
    totals,
  };
}

/** Repeat or resample a short profile to a longer scenario length. */
export function extendProfile(profile: DemandProfile, targetDuration: number): DemandProfile {
  const bins = binsFor(targetDuration, profile.binSeconds);
  const rates = profile.rates.map((r) => Array.from({ length: bins }, (_, i) => r[i % r.length]));
  return { ...profile, duration: targetDuration, rates };
}

export function applyMultipliers(profile: DemandProfile, mult: number[], windows: { approach: number; from: number; to: number; mult: number }[]): DemandProfile {
  const rates = profile.rates.map((r, ap) =>
    r.map((v, b) => {
      const t = (b + 0.5) * profile.binSeconds;
      let x = v * (mult[ap] ?? 1);
      for (const w of windows) if (w.approach === ap && t >= w.from && t < w.to) x *= w.mult;
      return x;
    }),
  );
  return { ...profile, rates };
}

// ---------------------------------------------------------------------------
// Saturation flow from stop-line crossings
// ---------------------------------------------------------------------------

export interface SatFlowResult {
  perLane: number; // PCU per hour per lane
  startupLost: number;
  headways: number[]; // seconds between consecutive saturated crossings
  samples: number;
  isDefault: boolean;
}

export function measureSaturation(deps: DepartRec[], greenStarts: { t: number; phase: number }[], p: Params): SatFlowResult {
  const headways: number[] = [];
  let pcuSum = 0;
  let timeSum = 0;
  const byAp: DepartRec[][] = [[], [], [], []];
  for (const d of deps) byAp[d.ap].push(d);
  for (const list of byAp) {
    let streak: DepartRec[] = [];
    const flush = () => {
      if (streak.length >= 4) {
        const span = streak[streak.length - 1].t - streak[0].t;
        if (span > 0) {
          const pcu = streak.slice(1).reduce((s, d) => s + d.pcu, 0);
          pcuSum += pcu;
          timeSum += span;
        }
        for (let i = 1; i < streak.length; i++) headways.push(streak[i].t - streak[i - 1].t);
      }
      streak = [];
    };
    for (const d of list) {
      if (streak.length && d.t - streak[streak.length - 1].t > 4) flush();
      streak.push(d);
      if (!d.sat) flush();
    }
    flush();
  }
  if (timeSum < 30 || headways.length < 20) {
    return { perLane: p.satFlowPerLane, startupLost: p.startupLost, headways, samples: headways.length, isDefault: true };
  }
  const perApproach = (pcuSum / timeSum) * 3600;
  // startup lost: first crossing after green start minus the saturated headway
  const firsts: number[] = [];
  for (const g of greenStarts) {
    const aps = phasesFor(p.fourPhase)[g.phase] ?? [];
    for (const ap of aps) {
      const first = byAp[ap].find((d) => d.t >= g.t);
      if (first && first.t - g.t < 12) firsts.push(first.t - g.t);
    }
  }
  const meanFirst = firsts.length ? firsts.reduce((a, b) => a + b, 0) / firsts.length : p.startupLost + 1;
  const hw = 3600 / perApproach;
  const lost = Math.max(0.5, Math.min(5, meanFirst - hw));
  return { perLane: perApproach / p.lanes, startupLost: lost, headways, samples: headways.length, isDefault: false };
}
