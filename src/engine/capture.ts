import type { DemandProfile, ObservedTiming, Params } from '../contracts';
import { SCENARIOS, DEFAULT_OPTIONS, NO_NOISE } from './params';
import { baseProfile, binArrivals, scenarioProfile, type BinnedCounts } from './demand';
import { Sim, type ArriveRec, type DepartRec } from './sim';

/**
 * The "recorded clip" of the sample junction. It is produced by the app's own
 * reference run with slightly different saturation flow than the default
 * parameters, so the twin has something real to be calibrated against.
 */
export interface SampleCapture {
  seed: number;
  duration: number;
  trueSatFlowPerLane: number;
  observed: ObservedTiming;
  arrivals: ArriveRec[];
  departures: DepartRec[];
  greenStarts: { t: number; phase: number }[];
  queue: number[][]; // [approach][second] PCU
  lamps: number[][];
  waits: number[];
  binned: BinnedCounts;
}

export const CAPTURE_SEED = 4242;
export const CAPTURE_DURATION = 900;
export const TRUE_SAT = 1920;

let cached: SampleCapture | null = null;

export function captureParams(p: Params): Params {
  return { ...p, satFlowPerLane: TRUE_SAT, horizon: CAPTURE_DURATION };
}

export function captureDemand(p: Params): DemandProfile {
  const base = baseProfile(p, CAPTURE_DURATION);
  return scenarioProfile(base, SCENARIOS.A, p, CAPTURE_DURATION);
}

export function getSampleCapture(p: Params, observed: ObservedTiming): SampleCapture {
  if (cached) return cached;
  const params = captureParams(p);
  const sim = new Sim({
    params,
    demand: captureDemand(p),
    kind: 'observed',
    options: DEFAULT_OPTIONS,
    seed: CAPTURE_SEED,
    horizon: CAPTURE_DURATION,
    noise: NO_NOISE,
    emergencies: [],
    observed,
    record: true,
  }).run();
  cached = {
    seed: CAPTURE_SEED,
    duration: CAPTURE_DURATION,
    trueSatFlowPerLane: TRUE_SAT,
    observed,
    arrivals: sim.arriveRec,
    departures: sim.departRec,
    greenStarts: sim.greenStarts,
    queue: sim.qSeries,
    lamps: sim.lampSeries,
    waits: sim.waits,
    binned: binArrivals(sim.arriveRec, CAPTURE_DURATION, p.binSeconds),
  };
  return cached;
}

export function resetCaptureCache() {
  cached = null;
}

