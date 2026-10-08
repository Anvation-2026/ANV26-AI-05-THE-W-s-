import type { SignalTwinApi } from './SignalTwinApi';
import { NotConnectedError } from './SignalTwinApi';
import { mockApi } from './MockApi';
import { httpApi } from './HttpApi';
import { backendReady, backendUp, useBackend } from './backend';
import { ApiProblem } from './problem';

export { useBackend, startBackendMonitor, backendReady, backendUp } from './backend';
export { friendlyError, ApiProblem } from './problem';
export type { AnalyseProgress, AnalyseOutcome, AnalyseRequest, SignalTwinApi } from './SignalTwinApi';

/**
 * The API the pages use. It chooses a side for every call from the latest health check:
 * video analysis needs the back end; demand estimation from counts or detections uses it when it answers
 * and falls back to the browser when it does not; simulations stay in the browser unless the person
 * switched them to the server in the Back end dialog. The sample junction never leaves the browser.
 */
export const api: SignalTwinApi = {
  getJunction: () => mockApi.getJunction(),
  saveJunction: (c) => mockApi.saveJunction(c),
  analyseVideo: (req) => {
    if (!backendReady()) throw new NotConnectedError('Detecting vehicles in an uploaded video');
    return httpApi.analyseVideo(req);
  },
  // deleting must never silently skip: if the server cannot be reached the person is told, and the local record stays
  deleteServerVideo: (id) => httpApi.deleteServerVideo(id),
  async estimateDemand(src, junction, params, smoothing, binSeconds) {
    if (src.kind !== 'sample' && backendUp()) {
      try {
        return await httpApi.estimateDemand(src, junction, params, smoothing, binSeconds);
      } catch (e) {
        // A server that is unreachable or failing is not the person's fault: use the browser engine, which gives the same numbers.
        const down = e instanceof ApiProblem && (e.status === 0 || e.status >= 500);
        if (!down) throw e;
      }
    }
    return mockApi.estimateDemand(src, junction, params, smoothing, binSeconds);
  },
  runSimulation: (req) => (useBackend.getState().simulation === 'server' && backendUp() ? httpApi.runSimulation(req) : mockApi.runSimulation(req)),
  runExperiment: (req, onProgress) => (useBackend.getState().simulation === 'server' && backendUp() ? httpApi.runExperiment(req, onProgress) : mockApi.runExperiment(req, onProgress)),
};
