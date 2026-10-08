import { Cancelled, runExperiment, type ExperimentRequest, type ExperimentResult, type Progress } from './experiment';

export interface Job {
  promise: Promise<ExperimentResult>;
  cancel: () => void;
}

/** Runs an experiment in a Web Worker so the interface stays responsive. Falls back to the main thread if workers are unavailable. */
export function startExperiment(req: ExperimentRequest, onProgress: (p: Progress) => void): Job {
  if (typeof Worker === 'undefined') {
    let cancelled = false;
    return {
      promise: runExperiment(req, onProgress, () => cancelled),
      cancel: () => {
        cancelled = true;
      },
    };
  }
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  const promise = new Promise<ExperimentResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'progress') onProgress({ done: m.done, total: m.total, label: m.label });
      else if (m.type === 'done') {
        settled = true;
        worker.terminate();
        resolve(m.res);
      } else if (m.type === 'cancelled') {
        settled = true;
        worker.terminate();
        reject(new Cancelled());
      } else if (m.type === 'error') {
        settled = true;
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      if (!settled) reject(new Error(e.message || 'The simulation worker failed to start.'));
    };
    worker.postMessage({ type: 'run', req });
  });
  return {
    promise,
    cancel: () => {
      if (!settled) worker.postMessage({ type: 'cancel' });
    },
  };
}

export { Cancelled };
