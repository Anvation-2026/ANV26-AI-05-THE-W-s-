import type { DemandProfile, ObservedTiming, Params } from '../contracts';
import { DEFAULT_OPTIONS, NO_NOISE } from './params';
import type { Capture } from './capture';
import { Sim } from './sim';

export interface TwinValidation {
  times: number[];
  observed: number[]; // total queue PCU every 5 s, from the clip
  simulated: number[]; // mean over the twin seeds
  cycleLength: number;
  foldedObserved: number[]; // mean queue by second of the signal cycle
  foldedSimulated: number[];
  observedWaits: number[];
  simulatedWaits: number[];
  mae: number;
  meanObserved: number;
  meanSimulated: number;
  relMae: number;
  corr: number;
  verdict: 'Close match' | 'Moderate match' | 'Poor match';
  reasons: string[];
  seeds: number;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0,
    saa = 0,
    sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Mean of a series folded onto one signal cycle, so random arrivals average out and only the structure remains. */
function fold(series: number[], cycle: number): number[] {
  const sum = new Array(cycle).fill(0);
  const cnt = new Array(cycle).fill(0);
  for (let t = 0; t < series.length; t++) {
    sum[t % cycle] += series[t];
    cnt[t % cycle]++;
  }
  return sum.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
}

/**
 * Runs the Observed plan in the twin on several random seeds and compares the
 * averaged queue with what the clip showed. The clip is one random day, so the
 * comparison uses the cycle-averaged queue rather than second-by-second noise.
 */
export function validateTwin(params: Params, cap: Capture, demand: DemandProfile, observed: ObservedTiming, seed = 11, seeds = 6): TwinValidation {
  const horizon = cap.duration;
  const sims: Sim[] = [];
  for (let k = 0; k < seeds; k++) {
    sims.push(
      new Sim({
        params: { ...params, horizon },
        demand,
        kind: 'observed',
        options: DEFAULT_OPTIONS,
        seed: seed + k * 17,
        horizon,
        noise: NO_NOISE,
        emergencies: [],
        observed,
      }).run(),
    );
  }
  const total = (qs: number[][], t: number) => qs.reduce((s, q) => s + (q[t] ?? 0), 0);
  const obsSec: number[] = [];
  const simSec: number[] = [];
  for (let t = 0; t < horizon; t++) {
    obsSec.push(total(cap.queue, t));
    simSec.push(sims.reduce((s, sm) => s + total(sm.qSeries, t), 0) / seeds);
  }
  const times: number[] = [];
  const obs: number[] = [];
  const simu: number[] = [];
  for (let t = 0; t < horizon; t += 5) {
    times.push(t);
    obs.push(obsSec[t]);
    simu.push(simSec[t]);
  }
  const phases = observed.fourPhase ? 4 : 2;
  const cycle = Math.max(10, Math.round(observed.greens.slice(0, phases).reduce((a, b) => a + b, 0) + phases * (params.yellow + params.allRed)));
  const fo = fold(obsSec, cycle);
  const fs = fold(simSec, cycle);
  const meanObserved = obsSec.reduce((s, v) => s + v, 0) / obsSec.length;
  const meanSimulated = simSec.reduce((s, v) => s + v, 0) / simSec.length;
  const mae = fo.reduce((s, v, i) => s + Math.abs(v - fs[i]), 0) / cycle;
  const relMae = meanObserved > 0 ? mae / meanObserved : 1;
  const corr = pearson(fo, fs);
  const bias = meanObserved > 0 ? (meanSimulated - meanObserved) / meanObserved : 0;
  const verdict: TwinValidation['verdict'] = relMae < 0.2 && corr > 0.85 ? 'Close match' : relMae < 0.4 && corr > 0.6 ? 'Moderate match' : 'Poor match';
  const reasons: string[] = [];
  reasons.push(`Across one signal cycle the twin's queue differs from the clip's by ${mae.toFixed(1)} PCU on average, ${(relMae * 100).toFixed(0)} percent of the clip's mean queue of ${meanObserved.toFixed(1)} PCU.`);
  reasons.push(`The twin's mean queue is ${bias >= 0 ? 'higher' : 'lower'} than the clip's by ${Math.abs(bias * 100).toFixed(0)} percent. The queue rises and falls with the signal in a ${corr > 0.85 ? 'matching' : corr > 0.6 ? 'similar' : 'different'} shape, correlation ${corr.toFixed(2)}.`);
  const sat = params.satFlowPerLane;
  if (Math.abs(sat - cap.trueSatFlowPerLane) / cap.trueSatFlowPerLane > 0.03) {
    reasons.push(`Saturation flow in the twin is ${sat} PCU per hour per lane. Stop-line crossings in the clip suggest about ${Math.round(cap.trueSatFlowPerLane)}. Calibrate it on the Demand page or here.`);
  }
  return {
    times,
    observed: obs,
    simulated: simu,
    cycleLength: cycle,
    foldedObserved: fo,
    foldedSimulated: fs,
    observedWaits: cap.waits,
    simulatedWaits: sims.flatMap((s) => s.waits),
    mae,
    meanObserved,
    meanSimulated,
    relMae,
    corr,
    verdict,
    reasons,
    seeds,
  };
}
