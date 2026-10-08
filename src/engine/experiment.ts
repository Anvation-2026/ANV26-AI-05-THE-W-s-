import type {
  ComparisonResult,
  ControllerKind,
  ControllerOptions,
  DemandProfile,
  EmergencyEvent,
  Metrics,
  NoiseSpec,
  ObservedTiming,
  Params,
  Scenario,
  StatSet,
} from '../contracts';
import { scenarioProfile, websterPlan } from './demand';
import { buildComparison, computeMetrics, pairedStats, statSet } from './metrics';
import { noiseAt, NO_NOISE } from './params';
import { Sim, type SimConfig } from './sim';

export interface RunSetup {
  params: Params;
  options: ControllerOptions;
  baseDemand: DemandProfile;
  scenario: Scenario;
  observed: ObservedTiming;
  noise?: NoiseSpec;
  emergencies?: EmergencyEvent[];
}

export function profileFor(s: RunSetup): DemandProfile {
  return scenarioProfile(s.baseDemand, s.scenario, s.params, s.params.horizon);
}

export function simConfig(s: RunSetup, kind: ControllerKind, seed: number, profile: DemandProfile, greens?: number[]): SimConfig {
  return {
    params: s.params,
    demand: profile,
    kind,
    options: s.options,
    seed,
    horizon: s.params.horizon,
    noise: kind === 'signaltwin' ? (s.noise ?? NO_NOISE) : NO_NOISE,
    emergencies: s.emergencies ?? [],
    observed: s.observed,
    websterGreens: greens,
  };
}

export function makeSim(s: RunSetup, kind: ControllerKind, seed: number, profile = profileFor(s), record = false): Sim {
  const greens = kind === 'webster' ? websterPlan(profile, s.params).greens : undefined;
  const cfg = simConfig(s, kind, seed, profile, greens);
  cfg.record = record;
  return new Sim(cfg);
}

export function runOne(s: RunSetup, kind: ControllerKind, seed: number, profile = profileFor(s)): Metrics {
  return computeMetrics(makeSim(s, kind, seed, profile).run());
}

// ---------------------------------------------------------------------------
// Experiment requests (run in a worker)
// ---------------------------------------------------------------------------

export type ExperimentRequest =
  | { type: 'compare'; setup: RunSetup; kinds: ControllerKind[]; seeds: number }
  | { type: 'ablation'; setup: RunSetup; seeds: number }
  | { type: 'noise'; setup: RunSetup; levels: number[]; seeds: number }
  | { type: 'grid'; setup: RunSetup; seeds: number; betas: number[]; gammas: number[] };

export interface AblationRow {
  id: string;
  label: string;
  metrics: Metrics[];
  stats: StatSet;
  vsFull: Record<keyof Metrics, { mean: number; ci: number; n: number; pct: number }> | null;
}
export interface NoiseRow {
  level: number;
  signaltwin: Metrics[];
  webster: Metrics[];
  stSignal: StatSet;
  stWebster: StatSet;
}
export interface GridRow {
  beta: number;
  gamma: number;
  avgDelay: number;
  longestRed: number;
  ok: boolean;
}

export type ExperimentResult =
  | { type: 'compare'; result: ComparisonResult }
  | { type: 'ablation'; rows: AblationRow[]; seeds: number }
  | { type: 'noise'; rows: NoiseRow[]; seeds: number }
  | { type: 'grid'; rows: GridRow[]; best: GridRow | null };

export interface Progress {
  done: number;
  total: number;
  label: string;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export async function runExperiment(
  req: ExperimentRequest,
  onProgress: (p: Progress) => void,
  isCancelled: () => boolean,
): Promise<ExperimentResult> {
  const s = req.setup;
  const profile = profileFor(s);
  const check = () => {
    if (isCancelled()) throw new Cancelled();
  };

  if (req.type === 'compare') {
    const per: Partial<Record<ControllerKind, Metrics[]>> = {};
    for (const k of req.kinds) per[k] = [];
    for (let i = 0; i < req.seeds; i++) {
      check();
      for (const k of req.kinds) (per[k] as Metrics[]).push(runOne(s, k, i + 1, profile));
      onProgress({ done: i + 1, total: req.seeds, label: `Seed ${i + 1} of ${req.seeds}` });
      await tick();
    }
    return { type: 'compare', result: buildComparison(s.scenario.id, s.params.horizon, per) };
  }

  if (req.type === 'ablation') {
    const variants: { id: string; label: string; patch: Partial<ControllerOptions> }[] = [
      { id: 'full', label: 'Full SignalTwin', patch: {} },
      { id: 'noFairness', label: 'Without fairness guard', patch: { fairnessGuard: false } },
      { id: 'noLookahead', label: 'Without platoon look-ahead', patch: { lookahead: false } },
      { id: 'noPcu', label: 'Without PCU weighting', patch: { pcuWeighting: false } },
      { id: 'noHyst', label: 'Without hysteresis', patch: { hysteresisOn: false } },
    ];
    const metrics: Record<string, Metrics[]> = {};
    variants.forEach((v) => (metrics[v.id] = []));
    const total = req.seeds * variants.length;
    let done = 0;
    for (let i = 0; i < req.seeds; i++) {
      check();
      for (const v of variants) {
        const setup: RunSetup = { ...s, options: { ...s.options, ...v.patch } };
        metrics[v.id].push(runOne(setup, 'signaltwin', i + 1, profile));
        done++;
      }
      onProgress({ done, total, label: `Seed ${i + 1} of ${req.seeds}` });
      await tick();
    }
    const rows: AblationRow[] = variants.map((v) => ({
      id: v.id,
      label: v.label,
      metrics: metrics[v.id],
      stats: statSet(metrics[v.id]),
      vsFull: v.id === 'full' ? null : pairedStats(metrics.full, metrics[v.id]),
    }));
    return { type: 'ablation', rows, seeds: req.seeds };
  }

  if (req.type === 'noise') {
    const rows: NoiseRow[] = [];
    const web: Metrics[] = [];
    for (let i = 0; i < req.seeds; i++) web.push(runOne(s, 'webster', i + 1, profile));
    const total = req.levels.length * req.seeds;
    let done = 0;
    for (const level of req.levels) {
      const sig: Metrics[] = [];
      for (let i = 0; i < req.seeds; i++) {
        check();
        const setup: RunSetup = { ...s, noise: noiseAt(level) };
        sig.push(runOne(setup, 'signaltwin', i + 1, profile));
        done++;
        if (i % 4 === 3) {
          onProgress({ done, total, label: `Noise ${level} percent, seed ${i + 1} of ${req.seeds}` });
          await tick();
        }
      }
      rows.push({ level, signaltwin: sig, webster: web, stSignal: statSet(sig), stWebster: statSet(web) });
      onProgress({ done, total, label: `Noise ${level} percent finished` });
      await tick();
    }
    return { type: 'noise', rows, seeds: req.seeds };
  }

  // grid search over beta and gamma
  const rows: GridRow[] = [];
  const total = req.betas.length * req.gammas.length;
  let done = 0;
  for (const beta of req.betas) {
    for (const gamma of req.gammas) {
      check();
      const setup: RunSetup = { ...s, params: { ...s.params, beta, gamma } };
      const ms: Metrics[] = [];
      for (let i = 0; i < req.seeds; i++) ms.push(runOne(setup, 'signaltwin', i + 1, profile));
      const st = statSet(ms);
      rows.push({
        beta,
        gamma,
        avgDelay: st.avgDelayVeh.mean,
        longestRed: st.longestRed.mean,
        ok: ms.every((m) => m.longestRed <= s.params.fairnessCap),
      });
      done++;
      onProgress({ done, total, label: `beta ${beta}, gamma ${gamma}` });
      await tick();
    }
  }
  const okRows = rows.filter((r) => r.ok);
  const pool = okRows.length ? okRows : rows;
  const best = pool.slice().sort((a, b) => a.avgDelay - b.avgDelay)[0] ?? null;
  return { type: 'grid', rows, best };
}
