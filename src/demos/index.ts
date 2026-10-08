import { PerceptionSchema, type JunctionConfig, type PerceptionResult } from '../contracts';
import { mockApi } from '../api/MockApi';
import { extendProfile } from '../engine/demand';
import { useApp } from '../store/app';
import { useVideo } from '../store/video';

/**
 * Example videos. Each has a drawn junction and the analysis the back end produced for it, so choosing one in the top bar shows the
 * video with its detections, counts, queues, demand and the plan comparison straight away, without uploading anything.
 * The analysis files are in public/demos. The videos are stock footage with a watermark, so they are not in the repository:
 * put them in public/demos as <id>.webm to see the picture (the numbers work without them).
 */
export interface Demo {
  /** Short name of the files in public/demos. */
  key: string;
  /** Junction id, always starting with demo-. */
  id: string;
  name: string;
  summary: string;
}

export const DEMOS: Demo[] = [
  { key: 'topdown', id: 'demo-topdown', name: 'Example: overhead four-way junction', summary: 'Drone view, four approaches, queues on three roads while one flows. The best example for the comparison.' },
  { key: 'bangalore', id: 'demo-bangalore', name: 'Example: Bangalore flyover road', summary: 'Handheld view of a congested road, two roads. The camera moves and the counting follows it.' },
  { key: 'delhi', id: 'demo-delhi', name: 'Example: Delhi highway', summary: 'Free-flowing highway seen from a bridge, two carriageways, no signal.' },
  { key: 'timelapse', id: 'demo-timelapse', name: 'Example: time-lapse junction (not usable)', summary: 'A sped-up drone clip. Detection works but time-based results are meaningless.' },
];

export const isDemoId = (id: string | undefined): boolean => !!id && id.startsWith('demo-');
export const demoOf = (id: string | undefined): Demo | undefined => DEMOS.find((d) => d.id === id);

const base = (): string => `${import.meta.env.BASE_URL ?? '/'}demos/`.replace(/\/\/+/g, '/');

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return (await r.json()) as T;
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
  const params = { ...st.params, yellow: j.observed.yellow, allRed: j.observed.allRed, fourPhase: j.observed.fourPhase, binSeconds: bin };
  // the same demand the Demand page would produce from these counts, applied so Console, Experiments and Report use it
  const est = await mockApi.estimateDemand({ kind: 'perception', result }, j, params, undefined, bin);
  const size = j.videoSize ?? { w: result.width, h: result.height, duration: seconds };
  useVideo.getState().set({ url: `${base()}${d.key}.webm`, name: `${d.key}.webm`, size });
  st.setJunction(j, false);
  st.setParams({ yellow: params.yellow, allRed: params.allRed, fourPhase: params.fourPhase, binSeconds: bin });
  st.setPerception(result, 'backend');
  st.setServerVideo(null);
  st.setDemand(extendProfile(est.profile, params.horizon));
  st.setAppliedDemand(new Date().toISOString());
}

/** Leaves an example: its video and analysis go, so the next junction starts clean. */
export function leaveDemo(): void {
  const st = useApp.getState();
  useVideo.getState().clear();
  if (st.perceptionOrigin === 'backend' && !st.serverVideo) st.setPerception(null);
  st.setDemand(null);
  st.setAppliedDemand(null);
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
