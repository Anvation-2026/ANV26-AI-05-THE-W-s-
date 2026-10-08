import { DEFAULT_PARAMS, SAMPLE_JUNCTION } from '../src/engine/params';
import { getSampleCapture, CAPTURE_DURATION } from '../src/engine/capture';
import { binArrivals, estimateDemand } from '../src/engine/demand';
import { validateTwin } from '../src/engine/twin';
const p = DEFAULT_PARAMS;
const cap = getSampleCapture(p, SAMPLE_JUNCTION.observed);
for (const [sat, st, seed] of [[1800,2,11],[1900,2,11],[1920,2,11],[1920,2,5],[1920,1.5,11],[2000,2,11],[1920,2,23]] as const) {
  const local = { ...p, satFlowPerLane: sat, startupLost: st, horizon: CAPTURE_DURATION };
  const est = estimateDemand(binArrivals(cap.arrivals, cap.duration, p.binSeconds), local);
  const v = validateTwin(local, cap, est.profile, SAMPLE_JUNCTION.observed, seed);
  console.log(sat, st, seed, v.verdict, 'mae', v.mae.toFixed(1), 'rel', v.relMae.toFixed(2), 'corr', v.corr.toFixed(2), 'bias', (v.meanSimulated/v.meanObserved).toFixed(2), 'meanObs', v.meanObserved.toFixed(1));
}

