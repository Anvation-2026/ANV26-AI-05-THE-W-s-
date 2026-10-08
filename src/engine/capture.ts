import { APPROACHES, type DemandProfile, type ObservedTiming, type Params, type PerceptionResult } from '../contracts';
import { SCENARIOS, DEFAULT_OPTIONS, NO_NOISE } from './params';
import { baseProfile, binArrivals, scenarioProfile, type BinnedCounts } from './demand';
import { Sim, type ArriveRec, type DepartRec } from './sim';

/**
 * A recorded clip that the twin is checked against. For the sample junction it is produced by the app's own
 * reference run with slightly different saturation flow than the default parameters. For a person's own
 * video it is built from the back end's analysis (captureFromPerception).
 */
export interface Capture {
  /** Where the numbers came from. */
  origin: 'sample' | 'video';
  /** False when the clip gave no way to measure it, for example no queue zone was drawn. */
  hasQueue: boolean;
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

/** Kept for older imports. */
export type SampleCapture = Capture;

export const CAPTURE_SEED = 4242;
export const CAPTURE_DURATION = 900;
export const TRUE_SAT = 1920;

let cached: Capture | null = null;

export function captureParams(p: Params): Params {
  return { ...p, satFlowPerLane: TRUE_SAT, horizon: CAPTURE_DURATION };
}

export function captureDemand(p: Params): DemandProfile {
  const base = baseProfile(p, CAPTURE_DURATION);
  return scenarioProfile(base, SCENARIOS.A, p, CAPTURE_DURATION);
}

export function getSampleCapture(p: Params, observed: ObservedTiming): Capture {
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
    origin: 'sample',
    hasQueue: true,
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


/**
 * Builds a Capture from the back end's analysis of the person's video, or null when it has no queue data to compare.
 * The queue, waits, arrivals and departures are what the video showed. Saturation flow is the measured value when
 * there was enough queue discharge to measure it, otherwise the current parameter, so the twin is not told a made-up target.
 */
export function captureFromPerception(r: PerceptionResult, p: Params, observed: ObservedTiming): Capture | null {
  if (!r.queue) return null;
  const queue = APPROACHES.map((a) => r.queue!.approaches[a] ?? []);
  const len = Math.max(...queue.map((q) => q.length));
  const lastFrame = r.frames.reduce((m, f) => Math.max(m, f.t), 0);
  const duration = Math.max(60, Math.min(len, Math.ceil(r.meta?.durationS ?? lastFrame)));
  const clip = queue.map((q) => Array.from({ length: duration }, (_, t) => q[t] ?? 0));
  const arrivals: ArriveRec[] = (r.counts ?? [])
    .filter((c) => c.line === 'upstream')
    .map((c) => ({ t: c.t, ap: APPROACHES.indexOf(c.approach), cls: c.cls }))
    .filter((a) => a.t < duration);
  const departures: DepartRec[] = (r.departures ?? []).map((d) => ({ t: d.t, ap: APPROACHES.indexOf(d.approach), cls: d.cls, pcu: d.pcu, sat: d.sat }));
  const measured = r.satFlow && !r.satFlow.isDefault;
  return {
    origin: 'video',
    hasQueue: clip.some((q) => q.some((v) => v > 0)),
    seed: 0,
    duration,
    trueSatFlowPerLane: measured ? r.satFlow!.perLane : p.satFlowPerLane,
    observed,
    arrivals,
    departures,
    greenStarts: [],
    queue: clip,
    lamps: [],
    waits: r.waits ?? [],
    binned: binArrivals(arrivals, duration, p.binSeconds),
  };
}
