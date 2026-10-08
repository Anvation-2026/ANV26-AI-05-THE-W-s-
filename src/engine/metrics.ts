import { METRIC_KEYS, type ComparisonResult, type ControllerKind, type Metrics, type Stat, type StatSet } from '../contracts';
import type { Sim } from './sim';

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** Jain's fairness index over per-approach average delays. 1.0 means perfectly even. */
export function jainIndex(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return 1;
  const s = v.reduce((a, b) => a + b, 0);
  const s2 = v.reduce((a, b) => a + b * b, 0);
  if (s2 === 0) return 1;
  return (s * s) / (v.length * s2);
}

export function computeMetrics(sim: Sim): Metrics {
  const t = sim.t;
  const waits = sim.waits.slice();
  let extraSum = [0, 0, 0, 0];
  let extraCnt = [0, 0, 0, 0];
  let pw = sim.peopleWait;
  let pc = sim.peopleCount;
  let longest = waits.reduce((a, b) => Math.max(a, b), 0);
  for (let ap = 0; ap < 4; ap++) {
    for (const v of sim.queue[ap]) {
      const w = t - v.queueT;
      waits.push(w);
      extraSum[ap] += w;
      extraCnt[ap]++;
      pw += w * v.people;
      pc += v.people;
      if (w > longest) longest = w;
    }
  }
  waits.sort((a, b) => a - b);
  const n = waits.length;
  const total = waits.reduce((a, b) => a + b, 0);
  const perAp: number[] = [];
  for (let ap = 0; ap < 4; ap++) {
    const c = sim.waitCount[ap] + extraCnt[ap];
    if (c > 0) perAp.push((sim.waitSum[ap] + extraSum[ap]) / c);
  }
  const hours = Math.max(1, t) / 3600;
  return {
    avgDelayVeh: n ? total / n : 0,
    avgDelayPerson: pc ? pw / pc : 0,
    p95Delay: percentile(waits, 0.95),
    longestRed: Math.max(...sim.maxRed),
    longestWait: longest,
    throughputVeh: sim.served / hours,
    throughputPeople: sim.servedPeople / hours,
    maxQueue: Math.max(...sim.maxQueue),
    jain: jainIndex(perAp),
    served: sim.served,
  };
}

const T_TABLE: [number, number][] = [
  [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365], [8, 2.306], [9, 2.262],
  [10, 2.228], [12, 2.179], [15, 2.131], [19, 2.093], [20, 2.086], [24, 2.064], [29, 2.045], [30, 2.042], [60, 2.0],
];
export function tCritical(df: number): number {
  if (df < 1) return 0;
  for (const [d, t] of T_TABLE) if (df <= d) return t;
  return 1.96;
}

export function stat(xs: number[]): Stat {
  const n = xs.length;
  if (n === 0) return { mean: 0, ci: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, ci: 0, n };
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { mean, ci: (tCritical(n - 1) * sd) / Math.sqrt(n), n };
}

export function statSet(ms: Metrics[]): StatSet {
  const out = {} as StatSet;
  for (const k of METRIC_KEYS) out[k] = stat(ms.map((m) => m[k]));
  out.served = stat(ms.map((m) => m.served));
  return out;
}

export function pairedStats(base: Metrics[], other: Metrics[]): Record<keyof Metrics, Stat & { pct: number }> {
  const out = {} as Record<keyof Metrics, Stat & { pct: number }>;
  const n = Math.min(base.length, other.length);
  const keys = [...METRIC_KEYS, 'served' as const];
  for (const k of keys) {
    const diffs: number[] = [];
    let baseMean = 0;
    for (let i = 0; i < n; i++) {
      diffs.push(other[i][k] - base[i][k]);
      baseMean += base[i][k];
    }
    baseMean /= Math.max(1, n);
    const s = stat(diffs);
    out[k] = { ...s, pct: baseMean !== 0 ? (s.mean / baseMean) * 100 : 0 };
  }
  return out;
}

export function buildComparison(
  scenarioId: string,
  horizon: number,
  per: Partial<Record<ControllerKind, Metrics[]>>,
  pairedAgainst: ControllerKind = 'webster',
): ComparisonResult {
  const stats: ComparisonResult['stats'] = {};
  const paired: ComparisonResult['paired'] = {};
  for (const k of Object.keys(per) as ControllerKind[]) {
    const ms = per[k] as Metrics[];
    stats[k] = statSet(ms);
  }
  const base = per[pairedAgainst];
  if (base) {
    for (const k of Object.keys(per) as ControllerKind[]) {
      if (k === pairedAgainst) continue;
      paired[k] = pairedStats(base, per[k] as Metrics[]);
    }
  }
  const any = Object.values(per)[0] ?? [];
  return {
    scenarioId,
    seeds: any.length,
    horizon,
    perController: per,
    stats,
    paired,
    completedAt: new Date().toISOString(),
  };
}

export const METRIC_LABELS: Record<keyof Metrics, { label: string; unit: string; better: 'lower' | 'higher'; digits: number }> = {
  avgDelayVeh: { label: 'Average delay per vehicle', unit: 's', better: 'lower', digits: 1 },
  avgDelayPerson: { label: 'Average delay per person', unit: 's', better: 'lower', digits: 1 },
  p95Delay: { label: '95th percentile delay', unit: 's', better: 'lower', digits: 1 },
  longestRed: { label: 'Longest red time', unit: 's', better: 'lower', digits: 0 },
  longestWait: { label: 'Longest vehicle wait', unit: 's', better: 'lower', digits: 0 },
  throughputVeh: { label: 'Throughput, vehicles', unit: 'per hour', better: 'higher', digits: 0 },
  throughputPeople: { label: 'Throughput, people', unit: 'per hour', better: 'higher', digits: 0 },
  maxQueue: { label: 'Maximum queue', unit: 'PCU', better: 'lower', digits: 1 },
  jain: { label: "Jain's fairness index", unit: '', better: 'higher', digits: 3 },
  served: { label: 'Vehicles served', unit: '', better: 'higher', digits: 0 },
};
