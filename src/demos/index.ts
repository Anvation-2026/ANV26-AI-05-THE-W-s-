import { PerceptionSchema, VEHICLE_CLASSES, type DemandProfile, type JunctionConfig, type PerceptionResult, type VehicleClass } from '../contracts';
import { binsFor } from '../engine/demand';
import { DEFAULT_PARAMS } from '../engine/params';
import { useApp } from '../store/app';
import { useVideo } from '../store/video';

/**
 * Example videos. Each has a drawn junction and the analysis the back end produced for it, so choosing one in the top bar shows the
 * video with its detections, counts, queues, demand and the plan comparison straight away, without uploading anything.
 * The analysis files are in public/demos. The videos are stock footage with a watermark, so they are not in the repository:
 * put them in public/demos as <id>.webm to see the picture (the numbers work without them).
 */
/** Busy-hour traffic assumed for an example, in vehicles per hour on North, South, East and West, and the share of each class. */
export interface AssumedTraffic {
  vph: [number, number, number, number];
  mix: Record<VehicleClass, number>;
  /** Longest red any road may wait, in seconds. A four-phase junction needs more than the 60 s default: its fixed plan alone reaches about 87 s. */
  fairnessCap?: number;
}

export interface Demo {
  /** Short name of the files in public/demos. */
  key: string;
  /** Junction id, always starting with demo-. */
  id: string;
  name: string;
  summary: string;
  /** What the simulations run on. It is an assumption for the example, not a count from the clip, and the app says so. */
  assumed: AssumedTraffic;
}

const mix = (twoWheeler: number, car: number, autoRickshaw: number, bus: number, truck: number): Record<VehicleClass, number> => ({ twoWheeler, car, autoRickshaw, bus, truck });

export const DEMOS: Demo[] = [
  {
    key: 'topdown', id: 'demo-topdown', name: 'Example: overhead four-way junction',
    summary: 'Drone view, four approaches, queues on three roads while one flows.',
    assumed: { vph: [560, 880, 740, 620], mix: mix(0.2, 0.6, 0.06, 0.07, 0.07), fairnessCap: 120 },
  },
  {
    key: 'bangalore', id: 'demo-bangalore', name: 'Example: Bangalore flyover road',
    summary: 'Handheld view of a congested road, two roads. The camera moves and the counting follows it.',
    assumed: { vph: [1480, 0, 760, 0], mix: mix(0.4, 0.38, 0.12, 0.05, 0.05) },
  },
  {
    key: 'delhi', id: 'demo-delhi', name: 'Example: Delhi highway',
    summary: 'Highway seen from a bridge, two carriageways.',
    assumed: { vph: [1820, 0, 1540, 0], mix: mix(0.3, 0.46, 0.08, 0.06, 0.1) },
  },
  {
    key: 'timelapse', id: 'demo-timelapse', name: 'Example: large multi-lane junction (time-lapse)',
    summary: 'A sped-up drone clip of a large junction. Its own counts are not usable because the video is sped up.',
    assumed: { vph: [560, 0, 220, 0], mix: mix(0.18, 0.62, 0.05, 0.08, 0.07) },
  },
];

export const isDemoId = (id: string | undefined): boolean => !!id && id.startsWith('demo-');
export const demoOf = (id: string | undefined): Demo | undefined => DEMOS.find((d) => d.id === id);

const base = (): string => `${import.meta.env.BASE_URL ?? '/'}demos/`.replace(/\/\/+/g, '/');

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return (await r.json()) as T;
}

/** A demand profile from an example's assumed busy-hour volumes, with the gentle slow swing the sample junction uses. */
export function assumedProfile(d: Demo, binSeconds: number, horizon: number): DemandProfile {
  const bins = binsFor(horizon, binSeconds);
  const rates = d.assumed.vph.map((vph, ap) =>
    Array.from({ length: bins }, (_, b) => (vph <= 0 ? 0 : Math.max(0, (vph / 3600) * (1 + 0.12 * Math.sin((2 * Math.PI * (b + 0.5) * binSeconds) / 540 + ap * 1.3))))),
  );
  const m = VEHICLE_CLASSES.reduce((acc, c) => ({ ...acc, [c]: d.assumed.mix[c] }), {} as Record<VehicleClass, number>);
  return { binSeconds, duration: horizon, rates, mix: [0, 1, 2, 3].map(() => ({ ...m })) };
}

/** Whether the video file for an example is present (it is not in the repository). */
export async function demoVideoAvailable(d: Demo): Promise<boolean> {
  try {
    const r = await fetch(`${base()}${d.key}.webm`, { method: 'HEAD' });
    return r.ok && (r.headers.get('content-type') ?? '').startsWith('video');
  } catch {
    return false;
  }
}

/** Makes an example the current junction: its drawing, its video, its analysis, and demand ready for the simulations. */
export async function loadDemo(d: Demo): Promise<void> {
  const [junction, result] = await Promise.all([
    getJson<JunctionConfig>(`${base()}${d.key}.junction.json`),
    getJson<unknown>(`${base()}${d.key}.result.json`).then((j) => PerceptionSchema.parse(j) as PerceptionResult),
  ]);
  const j: JunctionConfig = { ...junction, id: d.id, name: d.name, source: 'video', updatedAt: new Date().toISOString() };
  const st = useApp.getState();
  const seconds = result.meta?.durationS ?? Math.max(...result.frames.map((f) => f.t));
  const bin = seconds < 45 ? 5 : seconds < 120 ? 10 : 15;
  const params = { ...st.params, yellow: j.observed.yellow, allRed: j.observed.allRed, fourPhase: j.observed.fourPhase, binSeconds: bin, fairnessCap: d.assumed.fairnessCap ?? DEFAULT_PARAMS.fairnessCap };
  // the simulations run on the busy-hour traffic assumed for this example (shown on Perception), not on the few seconds of counts
  const profile = assumedProfile(d, params.binSeconds, params.horizon);
  const size = j.videoSize ?? { w: result.width, h: result.height, duration: seconds };
  useVideo.getState().set({ url: `${base()}${d.key}.webm`, name: `${d.key}.webm`, size });
  st.setJunction(j, false);
  st.setParams({ yellow: params.yellow, allRed: params.allRed, fourPhase: params.fourPhase, binSeconds: bin, fairnessCap: params.fairnessCap });
  st.setPerception(result, 'backend');
  st.setServerVideo(null);
  st.setDemand(profile);
  st.setAppliedDemand(new Date().toISOString());
}

/** Leaves an example: its video and analysis go, so the next junction starts clean. */
export function leaveDemo(): void {
  const st = useApp.getState();
  useVideo.getState().clear();
  if (st.perceptionOrigin === 'backend' && !st.serverVideo) st.setPerception(null);
  st.setDemand(null);
  st.setAppliedDemand(null);
  // the example's settings go with it
  const dp = DEFAULT_PARAMS;
  st.setParams({ fourPhase: dp.fourPhase, yellow: dp.yellow, allRed: dp.allRed, fairnessCap: dp.fairnessCap, binSeconds: dp.binSeconds });
}

/** After a reload the saved junction is still an example, but its video and analysis are not in memory: bring them back. */
export async function restoreDemo(): Promise<void> {
  const st = useApp.getState();
  const d = demoOf(st.junction.id);
  if (!d) return;
  if (!useVideo.getState().url) {
    const size = st.junction.videoSize ?? { w: 1280, h: 720, duration: 0 };
    useVideo.getState().set({ url: `${base()}${d.key}.webm`, name: `${d.key}.webm`, size });
  }
  if (!st.perception) {
    const result = PerceptionSchema.parse(await getJson<unknown>(`${base()}${d.key}.result.json`)) as PerceptionResult;
    useApp.getState().setPerception(result, 'backend');
  }
}
