/**
 * Data contracts shared by the front end and the future Python back end.
 * The back end should mirror these shapes (field names and units) exactly.
 * Units: seconds for time, PCU for weighted vehicles, metres for distance,
 * rates are per second unless the name says otherwise.
 */
import { z } from 'zod';

export const APPROACHES = ['N', 'S', 'E', 'W'] as const;
export type Approach = (typeof APPROACHES)[number];
export const APPROACH_NAMES: Record<Approach, string> = { N: 'North', S: 'South', E: 'East', W: 'West' };

export const VEHICLE_CLASSES = ['twoWheeler', 'car', 'autoRickshaw', 'bus', 'truck'] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export interface ClassSpec {
  label: string;
  tag: string; // single-letter tag used on detection boxes
  pcu: number;
  people: number;
}
export type ClassTable = Record<VehicleClass, ClassSpec>;

export interface Params {
  classes: ClassTable;
  satFlowPerLane: number; // PCU per hour per lane
  lanes: number; // inbound lanes per approach
  startupLost: number; // s
  yellow: number; // s
  allRed: number; // s
  minGreen: number; // s
  maxGreen: number; // s
  fairnessCap: number; // s without green
  travelMin: number; // s, upstream line to queue at free flow
  travelMax: number;
  binSeconds: number; // demand bin
  smoothing: number; // EWMA alpha for arrival profile, 0..1
  seeds: number; // random seeds per comparison
  horizon: number; // simulated seconds
  fourPhase: boolean;
  // controller
  beta: number;
  gamma: number;
  lookaheadH: number; // s
  hysteresis: number; // fraction, 0.15 = 15 percent
  vacGap: number; // s, vehicle-actuated passage time: a detector gap longer than this ends the green
}

export type ObjectiveMode = 'vehicles' | 'people';
export type ControllerKind = 'observed' | 'webster' | 'vac' | 'signaltwin';

export interface ControllerOptions {
  objective: ObjectiveMode;
  lookahead: boolean;
  fairnessGuard: boolean;
  pcuWeighting: boolean;
  hysteresisOn: boolean;
  emergencyPriority: boolean;
  /** Hold green until the vehicles that were in the queue zone when the green started have left. */
  queueClearance: boolean;
}

export interface Point {
  x: number;
  y: number;
}
export interface Line {
  a: Point;
  b: Point;
}
export interface Geometry {
  stopLines: Partial<Record<Approach, Line>>;
  upstreamLines: Partial<Record<Approach, Line>>;
  queueZones: Partial<Record<Approach, Point[]>>;
}
export interface Calibration {
  points: Point[]; // 4 pixel points
  distances: number[]; // metres: p0-p1, p1-p2, p2-p3, p3-p0
}
export interface ObservedTiming {
  greens: number[]; // per phase, seconds
  yellow: number;
  allRed: number;
  fourPhase: boolean;
}
export interface JunctionConfig {
  id: string;
  name: string;
  source: 'sample' | 'video' | 'counts';
  videoName?: string;
  videoSize?: { w: number; h: number; duration: number };
  countsRows?: number;
  geometry: Geometry;
  calibration: Calibration | null;
  observed: ObservedTiming;
  updatedAt: string;
}

/** Arrival demand replayed by the simulator. rates[a][bin] in vehicles per second. */
export interface DemandProfile {
  binSeconds: number;
  duration: number;
  rates: number[][]; // [approachIndex][bin]
  mix: Record<VehicleClass, number>[]; // [approachIndex], sums to 1
  satFlowMeasured?: number; // PCU per hour per lane
  satFlowIsDefault?: boolean;
  startupLostMeasured?: number;
}

export interface Scenario {
  id: 'A' | 'B' | 'custom';
  name: string;
  description: string;
  targetY: number; // overall flow ratio the base demand is scaled to
  multipliers: number[]; // per approach, on top of the target scaling
  surges: { approach: number; from: number; to: number; mult: number }[];
}

export interface EmergencyEvent {
  t: number;
  approach: number;
}

export interface NoiseSpec {
  missRate: number; // 0..1 vehicles the controller never sees
  labelError: number; // 0..1 class labels read as car
  delaySec: number; // counts reach the controller late
}

export type RuleKind =
  | 'stay'
  | 'switch'
  | 'mingreen'
  | 'maxgreen'
  | 'fairness'
  | 'emergency'
  | 'clearance'
  | 'extend'
  | 'gapout'
  | 'fixed';

export interface DecisionEntry {
  t: number;
  rule: RuleKind;
  from: number;
  to: number;
  action: string;
  reason: string;
  approaches: number[]; // approaches the entry concerns (for highlighting)
}

export interface Metrics {
  avgDelayVeh: number;
  avgDelayPerson: number;
  p95Delay: number;
  longestRed: number;
  longestWait: number;
  throughputVeh: number; // per hour
  throughputPeople: number; // per hour
  maxQueue: number; // PCU, worst approach
  jain: number;
  served: number;
}
export const METRIC_KEYS: (keyof Metrics)[] = [
  'avgDelayVeh',
  'avgDelayPerson',
  'p95Delay',
  'longestRed',
  'longestWait',
  'throughputVeh',
  'throughputPeople',
  'maxQueue',
  'jain',
];

export interface Stat {
  mean: number;
  ci: number; // half width of the 95 percent confidence interval
  n: number;
}
export type StatSet = Record<keyof Metrics, Stat>;

export interface ComparisonResult {
  scenarioId: string;
  seeds: number;
  horizon: number;
  perController: Partial<Record<ControllerKind, Metrics[]>>;
  stats: Partial<Record<ControllerKind, StatSet>>;
  paired: Partial<Record<ControllerKind, Record<keyof Metrics, Stat & { pct: number }>>>;
  completedAt: string;
}

/** Output of the vision pipeline. The back end should emit exactly this. */
export const PerceptionSchema = z.object({
  fps: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  frames: z.array(
    z.object({
      t: z.number().nonnegative(),
      detections: z.array(
        z.object({
          id: z.number().int(),
          cls: z.enum(VEHICLE_CLASSES),
          x: z.number(),
          y: z.number(),
          w: z.number().positive(),
          h: z.number().positive(),
          conf: z.number().min(0).max(1),
        }),
      ),
    }),
  ),
  counts: z
    .array(
      z.object({
        t: z.number().nonnegative(),
        approach: z.enum(APPROACHES),
        cls: z.enum(VEHICLE_CLASSES),
        line: z.enum(['upstream', 'stop']),
      }),
    )
    .optional(),
});
export type PerceptionResult = z.infer<typeof PerceptionSchema>;

export const JunctionSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  source: z.enum(['sample', 'video', 'counts']),
  videoName: z.string().optional(),
  videoSize: z.object({ w: z.number(), h: z.number(), duration: z.number() }).optional(),
  countsRows: z.number().optional(),
  geometry: z.object({
    stopLines: z.record(z.string(), z.any()),
    upstreamLines: z.record(z.string(), z.any()),
    queueZones: z.record(z.string(), z.any()),
  }),
  calibration: z
    .object({ points: z.array(z.object({ x: z.number(), y: z.number() })).length(4), distances: z.array(z.number()).length(4) })
    .nullable(),
  observed: z.object({
    greens: z.array(z.number()),
    yellow: z.number(),
    allRed: z.number(),
    fourPhase: z.boolean(),
  }),
  updatedAt: z.string(),
});

export interface CountsRow {
  t: number;
  approach: Approach;
  cls: VehicleClass;
  count: number;
}

// ---------------------------------------------------------------------------
// API request and response shapes (see src/api/SignalTwinApi.ts)
// ---------------------------------------------------------------------------

export interface SimRequest {
  params: Params;
  options: ControllerOptions;
  baseDemand: DemandProfile;
  scenario: Scenario;
  observed: ObservedTiming;
  noise?: NoiseSpec;
  emergencies?: EmergencyEvent[];
  controller: ControllerKind;
  seed: number;
}

export interface SimResult {
  metrics: Metrics;
  decisions: DecisionEntry[];
  queue: number[][]; // [approach][second] PCU
  lamps: number[][]; // [approach][second] 0 red, 1 yellow, 2 green
  seed: number;
  horizon: number;
}

export interface DemandEstimate {
  profile: DemandProfile;
  rawPcu: number[][];
  smoothPcu: number[][];
  totals: number[];
  satFlow: { perLane: number; startupLost: number; headways: number[]; samples: number; isDefault: boolean };
  source: 'sample' | 'counts' | 'perception';
  binSeconds: number;
}

export type SourceKind = 'sample' | 'counts' | 'perception';
