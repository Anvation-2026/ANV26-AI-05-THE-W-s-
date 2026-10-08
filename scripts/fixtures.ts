/**
 * Writes golden fixtures for the Python back end: inputs and the exact outputs the browser engine gives.
 * The back end's tests (signaltwin-api/tests/test_demand_golden.py) must reproduce these numbers.
 *
 *   npx vite-node scripts/fixtures.ts
 *
 * Regenerate and commit the JSON whenever src/engine/demand.ts changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROACHES, VEHICLE_CLASSES, type CountsRow, type Params, type PerceptionResult } from '../src/contracts';
import { DEFAULT_OPTIONS, DEFAULT_PARAMS, SCENARIOS, noiseAt } from '../src/engine/params';
import { baseProfile, binArrivals, binCountsCsv, estimateDemand, measureSaturation, type DepartRec } from '../src/engine/demand';
import { makeSim, profileFor, runExperiment, type ExperimentRequest, type RunSetup } from '../src/engine/experiment';
import { computeMetrics } from '../src/engine/metrics';
import type { ControllerKind, ControllerOptions, EmergencyEvent, NoiseSpec, ObservedTiming } from '../src/contracts';
void profileFor;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const q = (x: number) => Math.round(x * 1000) / 1000; // times with three decimals, as the back end writes them

function countsRows(seed: number, n: number, maxT: number): CountsRow[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({
    t: q(r() * maxT),
    approach: pick(r, APPROACHES),
    cls: pick(r, VEHICLE_CLASSES),
    count: Math.floor(r() * 7),
  }));
}

function perception(seed: number, n: number, maxT: number, upstreamOnly = false): PerceptionResult {
  const r = rng(seed);
  const counts = Array.from({ length: n }, () => ({
    t: q(r() * maxT),
    approach: pick(r, APPROACHES),
    cls: pick(r, VEHICLE_CLASSES),
    line: upstreamOnly || r() < 0.55 ? ('upstream' as const) : ('stop' as const),
  })).sort((a, b) => a.t - b.t);
  const frames = Array.from({ length: Math.floor(maxT / 0.2) + 1 }, (_, i) => ({ t: q(i * 0.2), detections: [] }));
  return { fps: 5, width: 1280, height: 720, frames, counts };
}

type Case = { name: string; request: unknown; expected: unknown };
const cases: Case[] = [];

function withParams(over: Partial<Params>): Params {
  return { ...DEFAULT_PARAMS, ...over };
}

function counts(name: string, rows: CountsRow[], over: Partial<Params> = {}, smoothing?: number, binSeconds?: number, omitParams = false) {
  const params = withParams(over);
  const p = { ...params, smoothing: smoothing ?? params.smoothing, binSeconds: binSeconds ?? params.binSeconds };
  const { binned } = binCountsCsv(rows, p.binSeconds);
  const est = estimateDemand(binned, p, p.smoothing);
  cases.push({
    name,
    request: { source: { kind: 'counts', rows }, params: omitParams ? undefined : params, smoothing, binSeconds },
    expected: {
      ...est,
      satFlow: { perLane: params.satFlowPerLane, startupLost: params.startupLost, headways: [], samples: 0, isDefault: true },
      source: 'counts',
      binSeconds: p.binSeconds,
    },
  });
}

function perceive(name: string, result: PerceptionResult, over: Partial<Params> = {}, smoothing?: number, binSeconds?: number) {
  const params = withParams(over);
  const p = { ...params, smoothing: smoothing ?? params.smoothing, binSeconds: binSeconds ?? params.binSeconds };
  const duration = Math.max(p.binSeconds, result.frames.reduce((m, f) => Math.max(m, f.t), 0) + p.binSeconds);
  const recs = (result.counts ?? []).filter((c) => c.line === 'upstream').map((c) => ({ t: c.t, ap: APPROACHES.indexOf(c.approach), cls: c.cls }));
  const est = estimateDemand(binArrivals(recs, duration, p.binSeconds), p, p.smoothing);
  cases.push({
    name,
    request: { source: { kind: 'perception', result }, params, smoothing, binSeconds },
    expected: {
      ...est,
      satFlow: { perLane: params.satFlowPerLane, startupLost: params.startupLost, headways: [], samples: 0, isDefault: true },
      source: 'perception',
      binSeconds: p.binSeconds,
    },
  });
}

counts('counts: default parameters', countsRows(1, 300, 900));
counts('counts: defaults omitted from the request', countsRows(1, 300, 900), {}, undefined, undefined, true);
counts('counts: 10 s bins, light smoothing', countsRows(2, 500, 1200), {}, 0.2, 10);
counts('counts: 30 s bins, heavy smoothing', countsRows(3, 500, 1200), {}, 0.9, 30);
counts('counts: smoothing of exactly one', countsRows(4, 200, 600), {}, 1, 15);
counts('counts: custom PCU values', countsRows(5, 400, 900), { classes: { ...DEFAULT_PARAMS.classes, bus: { ...DEFAULT_PARAMS.classes.bus, pcu: 3.5 }, twoWheeler: { ...DEFAULT_PARAMS.classes.twoWheeler, pcu: 0.33 } } });
counts('counts: a single row', [{ t: 0, approach: 'N', cls: 'car', count: 4 }]);
counts('counts: all zero counts', [{ t: 0, approach: 'N', cls: 'car', count: 0 }, { t: 30, approach: 'E', cls: 'bus', count: 0 }]);
counts('counts: one approach only', [0, 15, 30, 45, 60].map((t) => ({ t, approach: 'W' as const, cls: 'truck' as const, count: 2 })));
counts('counts: times on bin edges', [0, 15, 30, 14.999, 15.001, 44.999].map((t) => ({ t, approach: 'S' as const, cls: 'car' as const, count: 1 })));
perceive('perception: upstream and stop events', perception(6, 400, 600));
perceive('perception: only upstream events, 20 s bins', perception(7, 250, 900, true), {}, 0.5, 20);

// ---- saturation flow ------------------------------------------------------
type SatCase = { name: string; deps: DepartRec[]; greenStarts: { t: number; phase: number }[]; params: Params; expected: unknown };
const sat: SatCase[] = [];

function departures(seed: number, cycles: number, perGreen: number, headway: number, jitter: number, fourPhase: boolean) {
  const r = rng(seed);
  const deps: DepartRec[] = [];
  const greens: { t: number; phase: number }[] = [];
  const phases = fourPhase ? [[0], [1], [2], [3]] : [[0, 1], [2, 3]];
  let t = 5;
  for (let c = 0; c < cycles; c++) {
    phases.forEach((aps, phase) => {
      greens.push({ t, phase });
      for (const ap of aps) {
        let x = t + 2 + r();
        for (let k = 0; k < perGreen; k++) {
          const cls = pick(r, VEHICLE_CLASSES);
          deps.push({ t: q(x), ap, cls, pcu: DEFAULT_PARAMS.classes[cls].pcu, sat: k < perGreen - 2 });
          x += headway + (r() - 0.5) * jitter;
        }
      }
      t += 30 + 5;
    });
  }
  deps.sort((a, b) => a.t - b.t);
  return { deps, greens };
}

function satCase(name: string, seed: number, cycles: number, perGreen: number, headway: number, jitter: number, over: Partial<Params> = {}) {
  const params = withParams(over);
  const { deps, greens } = departures(seed, cycles, perGreen, headway, jitter, params.fourPhase);
  sat.push({ name, deps, greenStarts: greens, params, expected: measureSaturation(deps, greens, params) });
}
satCase('saturation: steady discharge, two phases', 11, 8, 12, 1.9, 0.4);
satCase('saturation: four phases', 12, 6, 10, 2.1, 0.6, { fourPhase: true });
satCase('saturation: one lane', 13, 8, 10, 2.0, 0.3, { lanes: 1 });
satCase('saturation: too little data falls back to defaults', 14, 1, 3, 2.0, 0.2);
satCase('saturation: long headways', 15, 8, 8, 3.8, 1.0);
satCase('saturation: nothing departed', 16, 0, 0, 2.0, 0.2);


// ---- simulator ------------------------------------------------------------
type SimCase = { name: string; request: unknown; expected: unknown };
const simCases: SimCase[] = [];

function setupOf(over: Partial<Params>, opts: Partial<ControllerOptions>, scenario: 'A' | 'B', observed: ObservedTiming, noise?: NoiseSpec, emergencies?: EmergencyEvent[]): RunSetup {
  const params = { ...DEFAULT_PARAMS, horizon: 600, ...over };
  return { params, options: { ...DEFAULT_OPTIONS, ...opts }, baseDemand: baseProfile(params, params.horizon), scenario: SCENARIOS[scenario], observed, noise, emergencies };
}

function simCase(name: string, setup: RunSetup, kind: ControllerKind, seed: number) {
  const sim = makeSim(setup, kind, seed).run();
  simCases.push({
    name,
    request: { params: setup.params, options: setup.options, baseDemand: setup.baseDemand, scenario: setup.scenario, observed: setup.observed, noise: setup.noise, emergencies: setup.emergencies, controller: kind, seed },
    expected: { metrics: computeMetrics(sim), decisions: sim.decisions, queue: sim.qSeries, lamps: sim.lampSeries, seed, horizon: setup.params.horizon },
  });
}

const OBS2: ObservedTiming = { greens: [38, 30], yellow: 3, allRed: 2, fourPhase: false };
const OBS4: ObservedTiming = { greens: [24, 22, 24, 22], yellow: 3, allRed: 2, fourPhase: true };
const KINDS: ControllerKind[] = ['observed', 'webster', 'vac', 'signaltwin'];
for (const sc of ['A', 'B'] as const) for (const k of KINDS) simCase(`${k}, scenario ${sc}`, setupOf({}, {}, sc, OBS2), k, 3);
for (const k of KINDS) simCase(`${k}, four phases`, setupOf({ fourPhase: true }, {}, 'A', OBS4), k, 5);
for (const k of KINDS) simCase(`${k}, four phases, surge`, setupOf({ fourPhase: true }, {}, 'B', OBS4), k, 6);
simCase('signaltwin, 20 percent detection noise', setupOf({}, {}, 'A', OBS2, noiseAt(20)), 'signaltwin', 7);
simCase('signaltwin, 30 percent noise and delay', setupOf({}, {}, 'B', OBS2, noiseAt(30)), 'signaltwin', 8);
simCase('signaltwin, emergency vehicles', setupOf({}, {}, 'A', OBS2, undefined, [{ t: 100, approach: 1 }, { t: 220, approach: 2 }, { t: 221, approach: 3 }]), 'signaltwin', 9);
simCase('vac, emergency vehicles', setupOf({}, {}, 'A', OBS2, undefined, [{ t: 150, approach: 3 }]), 'vac', 9);
const optionSets: [string, Partial<ControllerOptions>][] = [
  ['people objective', { objective: 'people' }],
  ['no look-ahead', { lookahead: false }],
  ['no PCU weighting', { pcuWeighting: false }],
  ['no hysteresis', { hysteresisOn: false }],
  ['no fairness guard', { fairnessGuard: false }],
  ['no queue clearance', { queueClearance: false }],
  ['no emergency priority', { emergencyPriority: false }],
];
for (const [label, o] of optionSets) {
  simCase(`signaltwin, ${label}`, setupOf({}, o, 'B', OBS2, undefined, [{ t: 200, approach: 0 }]), 'signaltwin', 11);
  simCase(`vac, ${label}`, setupOf({}, o, 'B', OBS2), 'vac', 11);
}
const paramSets: [string, Partial<Params>][] = [
  ['one lane', { lanes: 1 }],
  ['low saturation flow', { satFlowPerLane: 1400 }],
  ['fractional start-up lost time', { startupLost: 2.5 }],
  ['long minimum green', { minGreen: 15, maxGreen: 40 }],
  ['tight fairness cap', { fairnessCap: 50 }],
  ['short passage gap', { vacGap: 2 }],
  ['large beta, small gamma', { beta: 2.25, gamma: 0.125 }],
  ['wide travel time range', { travelMin: 5, travelMax: 20 }],
  ['coarse bins', { binSeconds: 30 }],
  ['yellow 4 s, all red 1 s', { yellow: 4, allRed: 1 }],
];
for (const [label, o] of paramSets) {
  simCase(`signaltwin, ${label}`, setupOf(o, {}, 'B', OBS2), 'signaltwin', 13);
  simCase(`webster, ${label}`, setupOf(o, {}, 'A', OBS2), 'webster', 13);
}
for (let seed = 1; seed <= 12; seed++) simCase(`observed, seed ${seed}`, setupOf({ horizon: 300 }, {}, 'A', OBS2), 'observed', seed);

// ---- experiments ----------------------------------------------------------
type ExpCase = { name: string; request: unknown; expected: unknown };
const expCases: ExpCase[] = [];
async function expCase(name: string, req: ExperimentRequest) {
  const result = await runExperiment(req, () => undefined, () => false);
  expCases.push({ name, request: req, expected: result });
}
const small = setupOf({ horizon: 400 }, {}, 'B', OBS2);
await expCase('compare, four controllers', { type: 'compare', setup: small, kinds: KINDS, seeds: 3 });
await expCase('compare, two controllers', { type: 'compare', setup: setupOf({ horizon: 300 }, {}, 'A', OBS2), kinds: ['webster', 'signaltwin'], seeds: 2 });
await expCase('ablation', { type: 'ablation', setup: setupOf({ horizon: 300 }, {}, 'B', OBS2), seeds: 2 });
await expCase('noise sweep', { type: 'noise', setup: setupOf({ horizon: 300 }, {}, 'B', OBS2), levels: [0, 15, 30], seeds: 2 });
await expCase('grid search', { type: 'grid', setup: setupOf({ horizon: 300 }, {}, 'B', OBS2), seeds: 2, betas: [1, 2], gammas: [0.5, 1] });

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../signaltwin-api/tests/golden');
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'demand.json'), JSON.stringify({ generatedBy: 'scripts/fixtures.ts', cases }));
writeFileSync(resolve(out, 'saturation.json'), JSON.stringify({ generatedBy: 'scripts/fixtures.ts', cases: sat }));
writeFileSync(resolve(out, 'sim.json'), JSON.stringify({ generatedBy: 'scripts/fixtures.ts', cases: simCases }));
writeFileSync(resolve(out, 'experiments.json'), JSON.stringify({ generatedBy: 'scripts/fixtures.ts', cases: expCases }));
console.log(`wrote ${cases.length} demand, ${sat.length} saturation, ${simCases.length} simulation and ${expCases.length} experiment cases to ${out}`);
