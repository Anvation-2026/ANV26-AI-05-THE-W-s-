import type { CountsRow, DemandEstimate, JunctionConfig, Params, PerceptionResult, SimRequest, SimResult } from '../contracts';
import { VEHICLE_CLASSES, APPROACHES } from '../contracts';
import { NotConnectedError, type SignalTwinApi } from './SignalTwinApi';
import { useApp } from '../store/app';
import { binArrivals, binCountsCsv, estimateDemand, measureSaturation, type BinnedCounts } from '../engine/demand';
import { getSampleCapture } from '../engine/capture';
import { computeMetrics } from '../engine/metrics';
import { makeSim } from '../engine/experiment';
import { startExperiment } from '../engine/workerClient';
import { SAMPLE_JUNCTION } from '../engine/params';

function binsFromPerception(r: PerceptionResult, binSeconds: number): { binned: BinnedCounts; duration: number } {
  const duration = Math.max(binSeconds, r.frames.reduce((m, f) => Math.max(m, f.t), 0) + binSeconds);
  const recs = (r.counts ?? [])
    .filter((c) => c.line === 'upstream')
    .map((c) => ({ t: c.t, ap: APPROACHES.indexOf(c.approach), cls: c.cls }));
  return { binned: binArrivals(recs, duration, binSeconds), duration };
}

export const mockApi: SignalTwinApi = {
  async getJunction() {
    return useApp.getState().junction;
  },
  async saveJunction(c: JunctionConfig) {
    useApp.getState().setJunction({ ...c, updatedAt: new Date().toISOString() }, c.id === SAMPLE_JUNCTION.id);
  },
  async analyseVideo() {
    throw new NotConnectedError('Detecting vehicles in an uploaded video');
  },
  async deleteServerVideo() {
    /* nothing is stored on a server in this mode */
  },
  async estimateDemand(src, junction, params: Params, smoothing, binSeconds): Promise<DemandEstimate> {
    const p = { ...params, smoothing: smoothing ?? params.smoothing, binSeconds: binSeconds ?? params.binSeconds };
    if (src.kind === 'sample') {
      const cap = getSampleCapture(params, junction.observed);
      const binned = binArrivals(cap.arrivals, cap.duration, p.binSeconds);
      const est = estimateDemand(binned, p, p.smoothing);
      const sat = measureSaturation(cap.departures, cap.greenStarts, p);
      return { ...est, satFlow: sat, source: 'sample', binSeconds: p.binSeconds, computedBy: 'browser' };
    }
    if (src.kind === 'counts') {
      const { binned } = binCountsCsv(src.rows, p.binSeconds);
      const est = estimateDemand(binned, p, p.smoothing);
      return {
        ...est,
        satFlow: { perLane: params.satFlowPerLane, startupLost: params.startupLost, headways: [], samples: 0, isDefault: true },
        source: 'counts',
        binSeconds: p.binSeconds,
        computedBy: 'browser',
      };
    }
    const { binned } = binsFromPerception(src.result, p.binSeconds);
    const est = estimateDemand(binned, p, p.smoothing);
    return {
      ...est,
      satFlow: { perLane: params.satFlowPerLane, startupLost: params.startupLost, headways: [], samples: 0, isDefault: true },
      source: 'perception',
      binSeconds: p.binSeconds,
      computedBy: 'browser',
    };
  },
  async runSimulation(req: SimRequest): Promise<SimResult> {
    const sim = makeSim(
      {
        params: req.params,
        options: req.options,
        baseDemand: req.baseDemand,
        scenario: req.scenario,
        observed: req.observed,
        noise: req.noise,
        emergencies: req.emergencies,
      },
      req.controller,
      req.seed,
    ).run();
    return { metrics: computeMetrics(sim), decisions: sim.decisions, queue: sim.qSeries, lamps: sim.lampSeries, seed: req.seed, horizon: req.params.horizon };
  },
  runExperiment(req, onProgress) {
    return startExperiment(req, onProgress);
  },
};

export const api: SignalTwinApi = mockApi;

/** Helper for the Counts CSV parser used by Setup. */
export function parseCountsCsv(text: string): { rows: CountsRow[]; error: string | null } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return { rows: [], error: 'The file has no data rows. Add a header and at least one row.' };
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const need = ['time', 'approach', 'class', 'count'];
  const miss = need.filter((n) => !header.includes(n));
  if (miss.length) return { rows: [], error: `Missing column${miss.length > 1 ? 's' : ''}: ${miss.join(', ')}. The header must be time,approach,class,count.` };
  const ix = Object.fromEntries(need.map((n) => [n, header.indexOf(n)]));
  const clsMap: Record<string, (typeof VEHICLE_CLASSES)[number]> = {
    twowheeler: 'twoWheeler',
    'two-wheeler': 'twoWheeler',
    bike: 'twoWheeler',
    motorcycle: 'twoWheeler',
    car: 'car',
    autorickshaw: 'autoRickshaw',
    'auto-rickshaw': 'autoRickshaw',
    auto: 'autoRickshaw',
    bus: 'bus',
    truck: 'truck',
  };
  const apMap: Record<string, (typeof APPROACHES)[number]> = { n: 'N', s: 'S', e: 'E', w: 'W', north: 'N', south: 'S', east: 'E', west: 'W' };
  const rows: CountsRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',').map((x) => x.trim());
    const t = Number(c[ix.time]);
    const count = Number(c[ix.count]);
    const ap = apMap[(c[ix.approach] ?? '').toLowerCase()];
    const cls = clsMap[(c[ix.class] ?? '').toLowerCase().replace(/\s+/g, '')];
    if (!Number.isFinite(t) || t < 0) return { rows: [], error: `Row ${i + 1}: time must be a number of seconds, 0 or more.` };
    if (!Number.isFinite(count) || count < 0) return { rows: [], error: `Row ${i + 1}: count must be a number, 0 or more.` };
    if (!ap) return { rows: [], error: `Row ${i + 1}: approach "${c[ix.approach]}" is not North, South, East or West.` };
    if (!cls) return { rows: [], error: `Row ${i + 1}: class "${c[ix.class]}" is not one of two-wheeler, car, auto-rickshaw, bus or truck.` };
    rows.push({ t, approach: ap, cls, count });
  }
  return { rows, error: null };
}

export const COUNTS_TEMPLATE = 'time,approach,class,count\n0,N,car,4\n0,N,two-wheeler,5\n0,S,car,3\n0,E,car,4\n0,W,bus,1\n15,N,car,5\n15,N,truck,1\n15,S,two-wheeler,4\n15,E,auto-rickshaw,2\n15,W,car,3\n';
