import {
  type ClassTable,
  type ControllerOptions,
  type Params,
  type JunctionConfig,
  type Scenario,
  type NoiseSpec,
} from '../contracts';

export const DEFAULT_CLASSES: ClassTable = {
  twoWheeler: { label: 'Two-wheeler', tag: 'T', pcu: 0.5, people: 1.3 },
  car: { label: 'Car', tag: 'C', pcu: 1.0, people: 1.5 },
  autoRickshaw: { label: 'Auto-rickshaw', tag: 'A', pcu: 1.0, people: 2.0 },
  bus: { label: 'Bus', tag: 'B', pcu: 2.75, people: 30 },
  truck: { label: 'Truck', tag: 'K', pcu: 2.75, people: 1.2 },
};

export const DEFAULT_PARAMS: Params = {
  classes: DEFAULT_CLASSES,
  satFlowPerLane: 1800,
  lanes: 2,
  startupLost: 2,
  yellow: 3,
  allRed: 2,
  minGreen: 10,
  maxGreen: 50,
  fairnessCap: 60,
  travelMin: 8,
  travelMax: 12,
  binSeconds: 15,
  smoothing: 0.35,
  seeds: 20,
  horizon: 1800,
  fourPhase: false,
  // Tuned by grid search in this simulator (see scripts/sweep.ts). The project
  // notes suggest about 15 percent hysteresis; in this queue model a margin of
  // 60 percent switched less often and gave lower delay, so it is the default.
  beta: 1.5,
  gamma: 0.5,
  lookaheadH: 9,
  hysteresis: 0.6,
  vacGap: 3,
};

export const DEFAULT_OPTIONS: ControllerOptions = {
  objective: 'vehicles',
  lookahead: true,
  fairnessGuard: true,
  pcuWeighting: true,
  hysteresisOn: true,
  emergencyPriority: true,
  queueClearance: true,
};

export const NO_NOISE: NoiseSpec = { missRate: 0, labelError: 0, delaySec: 0 };

export function noiseAt(pct: number): NoiseSpec {
  return { missRate: pct / 100, labelError: (pct / 100) * 0.5, delaySec: Math.round(pct / 10) };
}

export const SCENARIOS: Record<'A' | 'B', Scenario> = {
  A: {
    id: 'A',
    name: 'Scenario A, balanced load',
    description: 'Moderate demand on every approach, about 70 percent of junction capacity.',
    targetY: 0.7,
    multipliers: [1, 1, 1, 1],
    surges: [],
  },
  B: {
    id: 'B',
    name: 'Scenario B, surge',
    description: 'North rises sharply from minute 7 to minute 14 and goes past capacity while the other approaches stay normal.',
    targetY: 0.7,
    multipliers: [1, 1, 1, 1],
    surges: [{ approach: 0, from: 420, to: 840, mult: 2.6 }],
  },
};

export const SAMPLE_JUNCTION: JunctionConfig = {
  id: 'sample-junction',
  name: 'Sample junction, four-way',
  source: 'sample',
  geometry: { stopLines: {}, upstreamLines: {}, queueZones: {} },
  calibration: null,
  observed: { greens: [38, 30], yellow: 3, allRed: 2, fourPhase: false },
  updatedAt: '2026-10-08T00:00:00.000Z',
};

/** Phases as lists of approach indices. N=0, S=1, E=2, W=3. */
export function phasesFor(fourPhase: boolean): number[][] {
  return fourPhase ? [[0], [1], [2], [3]] : [[0, 1], [2, 3]];
}
export function phaseName(phase: number[], names = ['N', 'S', 'E', 'W']): string {
  if (phase.length === 2 && phase[0] === 0 && phase[1] === 1) return 'NS';
  if (phase.length === 2 && phase[0] === 2 && phase[1] === 3) return 'EW';
  return phase.map((i) => names[i]).join('');
}
