import type {
  CountsRow,
  DemandEstimate,
  JunctionConfig,
  Params,
  PerceptionResult,
  SimRequest,
  SimResult,
} from '../contracts';
import type { ExperimentRequest, ExperimentResult, Progress } from '../engine/experiment';

/**
 * The only seam between the interface and the engine. The mock below runs
 * everything in the browser. The Python back end replaces it by implementing
 * HttpApi with the same shapes (see src/contracts).
 */
export interface SignalTwinApi {
  getJunction(): Promise<JunctionConfig>;
  saveJunction(c: JunctionConfig): Promise<void>;
  /** Vision pipeline: video in, detections and counts out. */
  analyseVideo(file: File, junction: JunctionConfig, onProgress: (p: number) => void): Promise<PerceptionResult>;
  estimateDemand(
    src: { kind: 'sample' } | { kind: 'counts'; rows: CountsRow[] } | { kind: 'perception'; result: PerceptionResult },
    junction: JunctionConfig,
    params: Params,
    smoothing?: number,
    binSeconds?: number,
  ): Promise<DemandEstimate>;
  runSimulation(req: SimRequest): Promise<SimResult>;
  runExperiment(req: ExperimentRequest, onProgress: (p: Progress) => void): { promise: Promise<ExperimentResult>; cancel: () => void };
}

export class NotConnectedError extends Error {
  constructor(what: string) {
    super(`${what} needs the back end, which is not connected in this version.`);
    this.name = 'NotConnectedError';
  }
}
