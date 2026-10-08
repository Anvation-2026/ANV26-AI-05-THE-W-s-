import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  ComparisonResult,
  ControllerOptions,
  DemandProfile,
  CountsRow,
  JunctionConfig,
  ObjectiveMode,
  Params,
  PerceptionResult,
} from '../contracts';
import { DEFAULT_OPTIONS, DEFAULT_PARAMS, SAMPLE_JUNCTION } from '../engine/params';
import type { AblationRow, GridRow, NoiseRow } from '../engine/experiment';
import { clearResults } from './results';

export interface RunRecord {
  id: string;
  kind: 'compare' | 'ablation' | 'noise' | 'grid';
  label: string;
  at: string;
  scenarioId: string;
  seeds: number;
  data: ComparisonResult | { rows: AblationRow[] } | { rows: NoiseRow[] } | { rows: GridRow[]; best: GridRow | null };
}

export interface Calibrated {
  satFlowPerLane: number;
  startupLost: number;
  travelMin: number;
  travelMax: number;
  verdict: string;
  mae: number;
  at: string;
}

/** A video that was sent to the back end, kept so it can be found again and deleted. The video itself is not stored here. */
export interface ServerVideo {
  videoId: string;
  filename: string;
  size: number;
  /** name, size and modified time of the file, to recognise it again in this browser */
  fileKey: string;
  uploadedAt: string;
  jobId?: string;
  /** key of the analysis result in IndexedDB */
  resultKey?: string;
}

export type PerceptionOrigin = 'file' | 'backend';

interface AppState {
  junction: JunctionConfig;
  usingSample: boolean;
  params: Params;
  options: ControllerOptions;
  countsRows: CountsRow[];
  perception: PerceptionResult | null;
  perceptionOrigin: PerceptionOrigin | null;
  serverVideo: ServerVideo | null;
  runs: RunRecord[];
  calibrated: Calibrated | null;
  appliedDemandAt: string | null;
  demand: DemandProfile | null;
  scenarioId: 'A' | 'B';
  seed: number;
  draft: { step: number } | null;

  setJunction: (j: JunctionConfig, sample?: boolean) => void;
  setParams: (p: Partial<Params>) => void;
  resetParams: () => void;
  setOptions: (o: Partial<ControllerOptions>) => void;
  setObjective: (m: ObjectiveMode) => void;
  setCounts: (rows: CountsRow[]) => void;
  setPerception: (p: PerceptionResult | null, origin?: PerceptionOrigin) => void;
  setServerVideo: (v: ServerVideo | null) => void;
  addRun: (r: RunRecord) => void;
  clearRuns: () => void;
  setCalibrated: (c: Calibrated | null) => void;
  setAppliedDemand: (at: string | null) => void;
  setDemand: (d: DemandProfile | null) => void;
  setScenario: (id: 'A' | 'B') => void;
  setSeed: (n: number) => void;
  resetSample: () => void;
  deleteAll: () => void;
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      junction: SAMPLE_JUNCTION,
      usingSample: true,
      params: DEFAULT_PARAMS,
      options: DEFAULT_OPTIONS,
      countsRows: [],
      perception: null,
      perceptionOrigin: null,
      serverVideo: null,
      runs: [],
      calibrated: null,
      appliedDemandAt: null,
      demand: null,
      scenarioId: 'A',
      seed: 1,
      draft: null,

      setJunction: (junction, sample = false) => set({ junction, usingSample: sample }),
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      resetParams: () => set({ params: DEFAULT_PARAMS }),
      setOptions: (o) => set((s) => ({ options: { ...s.options, ...o } })),
      setObjective: (m) => set((s) => ({ options: { ...s.options, objective: m } })),
      setCounts: (countsRows) => set({ countsRows }),
      setPerception: (perception, origin) => set({ perception, perceptionOrigin: perception ? (origin ?? 'file') : null }),
      setServerVideo: (serverVideo) => set({ serverVideo }),
      addRun: (r) => set((s) => ({ runs: [r, ...s.runs].slice(0, 24) })),
      clearRuns: () => set({ runs: [] }),
      setCalibrated: (calibrated) => set({ calibrated }),
      setAppliedDemand: (appliedDemandAt) => set({ appliedDemandAt }),
      setDemand: (demand) => set({ demand }),
      setScenario: (scenarioId) => set({ scenarioId }),
      setSeed: (seed) => set({ seed }),
      resetSample: () =>
        set({
          junction: SAMPLE_JUNCTION,
          usingSample: true,
          params: DEFAULT_PARAMS,
          options: DEFAULT_OPTIONS,
          countsRows: [],
          perception: null,
          perceptionOrigin: null,
          calibrated: null,
          appliedDemandAt: null,
          demand: null,
        }),
      deleteAll: () =>
        set({
          junction: SAMPLE_JUNCTION,
          usingSample: true,
          params: DEFAULT_PARAMS,
          options: DEFAULT_OPTIONS,
          countsRows: [],
          perception: null,
          perceptionOrigin: null,
          serverVideo: null,
          runs: [],
          calibrated: null,
          appliedDemandAt: null,
          demand: null,
          scenarioId: 'A',
          seed: 1,
        }),
    }),
    {
      name: 'signaltwin-state-v1',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (s) => ({
        junction: s.junction,
        usingSample: s.usingSample,
        params: s.params,
        options: s.options,
        countsRows: s.countsRows.slice(0, 20000),
        perceptionOrigin: s.perceptionOrigin,
        serverVideo: s.serverVideo,
        runs: s.runs.slice(0, 8),
        calibrated: s.calibrated,
        appliedDemandAt: s.appliedDemandAt,
        demand: s.demand,
        scenarioId: s.scenarioId,
        seed: s.seed,
      }),
    },
  ),
);

export function clearAllLocalData() {
  try {
    localStorage.removeItem('signaltwin-state-v1');
    localStorage.removeItem('signaltwin-theme');
    sessionStorage.clear();
  } catch {
    /* storage unavailable */
  }
  void clearResults();
  useApp.getState().deleteAll();
}

