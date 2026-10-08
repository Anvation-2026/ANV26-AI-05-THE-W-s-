/// <reference lib="webworker" />
import { Cancelled, runExperiment, type ExperimentRequest } from './experiment';

let cancelled = false;

self.onmessage = async (e: MessageEvent<{ type: 'run'; req: ExperimentRequest } | { type: 'cancel' }>) => {
  const m = e.data;
  if (m.type === 'cancel') {
    cancelled = true;
    return;
  }
  cancelled = false;
  try {
    const res = await runExperiment(
      m.req,
      (p) => (self as unknown as Worker).postMessage({ type: 'progress', ...p }),
      () => cancelled,
    );
    (self as unknown as Worker).postMessage({ type: 'done', res });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: err instanceof Cancelled ? 'cancelled' : 'error', message: String((err as Error)?.message ?? err) });
  }
};
