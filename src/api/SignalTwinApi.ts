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

export type AnalyseStage = 'upload' | 'queued' | 'decoding' | 'detecting' | 'postprocessing' | 'download';

export interface AnalyseProgress {
  stage: AnalyseStage;
  /** 0 to 1 within the stage. */
  fraction: number;
  /** 0 to 1 over the whole job, for one progress bar. */
  overall: number;
  /** A sentence that can be shown as it is. */
  message: string;
  etaS?: number;
  /** Place in the waiting list while queued. */
  position?: number;
}

export interface AnalyseRequest {
  file: File;
  junction: JunctionConfig;
  params: Params;
  signal: AbortSignal;
  onProgress: (p: AnalyseProgress) => void;
  /** A video id from an earlier upload of this same file, so it is not sent again. */
  knownVideoId?: string;
}

export interface AnalyseOutcome {
  result: PerceptionResult;
  videoId: string;
  jobId: string;
  fromCache: boolean;
}

/**
 * The only seam between the interface and the engines. MockApi runs everything in the browser.
 * HttpApi talks to the Python back end with the same shapes (see src/contracts). The router in
 * src/api/index.ts picks one at call time from the back end health check.
 */
export interface SignalTwinApi {
  getJunction(): Promise<JunctionConfig>;
  saveJunction(c: JunctionConfig): Promise<void>;
  /** Vision pipeline: video in, detections and counts out. Needs the back end. */
  analyseVideo(req: AnalyseRequest): Promise<AnalyseOutcome>;
  /** Removes an uploaded video, its analyses and its results from the server. */
  deleteServerVideo(videoId: string): Promise<void>;
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
    super(`${what} needs the back end, which is not connected.`);
    this.name = 'NotConnectedError';
  }
}
