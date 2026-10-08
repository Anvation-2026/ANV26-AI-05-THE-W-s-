import { useCallback, useEffect, useMemo, useState } from 'react';
import { JunctionView } from '../components/JunctionView';
import { Transport } from '../components/widgets';
import { Histogram, LineChart } from '../components/charts';
import { Badge, Button, NumberField, PageHeader, SkeletonChart, toast } from '../components/ui';
import { useApp } from '../store/app';
import { useRunner } from '../hooks/useRunner';
import { useCommands, Footer } from '../shell/Layout';
import { useRunStatus } from '../shell/status';
import { captureFromPerception, getSampleCapture } from '../engine/capture';
import { Link } from 'react-router-dom';
import { binArrivals, estimateDemand } from '../engine/demand';
import { validateTwin } from '../engine/twin';
import { DEFAULT_OPTIONS, NO_NOISE } from '../engine/params';
import { Sim } from '../engine/sim';

export default function Twin() {
  const params = useApp((s) => s.params);
  const setParams = useApp((s) => s.setParams);
  const junction = useApp((s) => s.junction);
  const calibrated = useApp((s) => s.calibrated);
  const perception = useApp((s) => s.perception);
  const origin = useApp((s) => s.perceptionOrigin);
  const setCalibrated = useApp((s) => s.setCalibrated);
  const setStatus = useRunStatus((s) => s.set);

  const [sat, setSat] = useState(params.satFlowPerLane);
  const [startup, setStartup] = useState(params.startupLost);
  const [tMin, setTMin] = useState(params.travelMin);
  const [tMax, setTMax] = useState(params.travelMax);
  const [seed, setSeed] = useState(11);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setReady(true), 250);
    return () => window.clearTimeout(id);
  }, []);

  // the clip is the person's own video once the back end has analysed it, otherwise the sample junction's recorded run
  const userCap = useMemo(() => (junction.source === 'video' && perception && origin === 'backend' ? captureFromPerception(perception, params, junction.observed) : null), [junction.source, perception, origin, params, junction.observed]);
  const cap = useMemo(() => userCap ?? getSampleCapture(params, junction.observed), [userCap, params, junction.observed]);
  const duration = cap.duration;
  const local = useMemo(() => ({ ...params, satFlowPerLane: sat, startupLost: startup, travelMin: tMin, travelMax: Math.max(tMin, tMax), horizon: duration }), [params, sat, startup, tMin, tMax, duration]);
  const est = useMemo(() => estimateDemand(binArrivals(cap.arrivals, cap.duration, params.binSeconds), local), [cap, params.binSeconds, local]);
  const val = useMemo(() => validateTwin(local, cap, est.profile, junction.observed, seed), [local, cap, est, junction.observed, seed]);

  const factory = useCallback(
    () => [
      new Sim({ params: local, demand: est.profile, kind: 'observed', options: DEFAULT_OPTIONS, seed, horizon: duration, noise: NO_NOISE, emergencies: [], observed: junction.observed }),
    ],
    [local, est, seed, junction.observed, duration],
  );
  const runner = useRunner(factory, duration, [factory]);
  useEffect(() => {
    runner.seek(Math.min(150, duration / 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useCommands({ toggle: () => runner.toggle(), restart: () => runner.reset(), speed: (d) => runner.setSpeed(Math.max(1, Math.min(8, d > 0 ? runner.speed * 2 : runner.speed / 2))) });
  useEffect(() => {
    setStatus(runner.playing ? 'Playing the twin' : 'Paused');
    return () => setStatus('Idle');
  }, [runner.playing, setStatus]);

  const accept = () => {
    setParams({ satFlowPerLane: sat, startupLost: startup, travelMin: tMin, travelMax: Math.max(tMin, tMax) });
    setCalibrated({ satFlowPerLane: sat, startupLost: startup, travelMin: tMin, travelMax: Math.max(tMin, tMax), verdict: val.verdict, mae: val.mae, at: new Date().toISOString() });
    toast(`Calibration accepted: ${val.verdict.toLowerCase()}.`);
  };

  const tone = val.verdict === 'Close match' ? 'sign' : val.verdict === 'Moderate match' ? 'paint' : 'stop';
  const changed = sat !== params.satFlowPerLane || startup !== params.startupLost || tMin !== params.travelMin || tMax !== params.travelMax;

  return (
    <>
      <div className="page page-wide">
        <PageHeader title="Twin" lede="Check that the simulator matches the video before you trust it. The twin replays the observed plan on the measured demand and its queues are compared with the queues the clip showed." />
        {cap.origin === 'sample' && junction.source === 'video' && (
          <div className="empty" role="status">
            <h3>Your video has not been analysed yet</h3>
            <p className="muted">This page is showing the sample junction's recorded run. To check the twin against your own video, analyse it in the last step of Setup.</p>
            <Link className="btn btn-primary" to="/setup">
              Go to Setup
            </Link>
          </div>
        )}
        {cap.origin === 'video' && !cap.hasQueue && (
          <div className="error-state" role="alert">
            <h3>No queue was measured in your video</h3>
            <p>No vehicle waited inside a queue zone, so there is nothing to compare the twin with. The verdict below is not meaningful.</p>
            <p>
              <strong>What to do:</strong> check that a queue zone is drawn over the waiting area for every approach in Setup, step 2, then analyse the video again. A clip with a red phase and a visible queue works best.
            </p>
          </div>
        )}
        <div className="split split-a">
          <section className="stack-sm" aria-label="Twin run">
            <div className="panel-asphalt on-asphalt" style={{ padding: 8 }}>
              <JunctionView runner={runner} simIndex={0} overlays={{ queueZones: true, labels: true }} caption="Twin, observed plan on measured demand" />
            </div>
            <div className="panel stack-sm">
              <Transport runner={runner} />
              <div style={{ width: 140 }}>
                <NumberField label="Twin seed" value={seed} min={1} max={999} onChange={(n) => setSeed(Math.round(n))} />
              </div>
            </div>
            <section className="panel stack-sm" aria-labelledby="cal-i">
              <h2 id="cal-i">Calibration inputs</h2>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div style={{ width: 170 }}>
                  <NumberField label="Saturation flow" value={sat} min={900} max={2600} step={10} unit="PCU/h/lane" onChange={setSat} />
                </div>
                <div style={{ width: 150 }}>
                  <NumberField label="Startup lost time" value={startup} min={0} max={6} step={0.5} unit="s" onChange={setStartup} />
                </div>
                <div style={{ width: 150 }}>
                  <NumberField label="Travel time, fastest" value={tMin} min={3} max={30} unit="s" onChange={setTMin} />
                </div>
                <div style={{ width: 150 }}>
                  <NumberField label="Travel time, slowest" value={tMax} min={3} max={40} unit="s" onChange={setTMax} />
                </div>
              </div>
              <div className="row">
                <Button variant="primary" onClick={accept}>
                  Accept calibration
                </Button>
                <Button
                  variant="quiet"
                  disabled={!changed}
                  disabledReason="The inputs already match the saved parameters."
                  onClick={() => {
                    setSat(params.satFlowPerLane);
                    setStartup(params.startupLost);
                    setTMin(params.travelMin);
                    setTMax(params.travelMax);
                  }}
                >
                  Revert inputs
                </Button>
              </div>
              <p className="muted">
                Accepting saves these values as the parameters every simulation uses. {calibrated ? `Last accepted ${new Date(calibrated.at).toLocaleString()}, ${calibrated.verdict.toLowerCase()}.` : 'Nothing has been accepted yet.'}
              </p>
            </section>
          </section>

          <div className="stack">
            <section className="panel stack" aria-labelledby="val-h">
              <div className="row-between">
                <h2 id="val-h">Validation</h2>
                <Badge tone={tone}>{val.verdict}</Badge>
              </div>
              {!ready ? (
                <SkeletonChart height={240} />
              ) : (
                <LineChart
                  title="Total queue in the clip against the twin, mean of seeds"
                  series={[
                    { id: 'o', label: 'Clip', data: val.times.map((t, i) => [t, val.observed[i]] as [number, number]), tone: 'old', dash: '6 4' },
                    { id: 's', label: 'Twin', data: val.times.map((t, i) => [t, val.simulated[i]] as [number, number]), tone: 'new' },
                  ]}
                  height={250}
                  xLabel="Time (s)"
                  yLabel="Queue (PCU)"
                  xFormat={(n) => String(Math.round(n))}
                  yFormat={(n) => n.toFixed(0)}
                  unit="PCU"
                  cursor={runner.t}
                />
              )}
              <ul className="status-list tnum">
                <li>
                  <span>Mean absolute error</span>
                  <span>{val.mae.toFixed(1)} PCU</span>
                </li>
                <li>
                  <span>Error against the observed mean</span>
                  <span>{(val.relMae * 100).toFixed(0)} percent</span>
                </li>
                <li>
                  <span>Correlation of the queue shape</span>
                  <span>{val.corr.toFixed(2)}</span>
                </li>
              </ul>
              <LineChart
                title={`Queue across one ${val.cycleLength} s signal cycle, averaged`}
                series={[
                  { id: 'fo', label: 'Clip', data: val.foldedObserved.map((v, i) => [i, v] as [number, number]), tone: 'old', dash: '6 4' },
                  { id: 'fs', label: 'Twin', data: val.foldedSimulated.map((v, i) => [i, v] as [number, number]), tone: 'new' },
                ]}
                height={210}
                xLabel="Second of the cycle"
                yLabel="Queue (PCU)"
                xFormat={(n) => String(Math.round(n))}
                yFormat={(n) => n.toFixed(0)}
                unit="PCU"
              />
              <div>
                <strong>Why this verdict</strong>
                <ul style={{ marginTop: 4 }}>
                  {val.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                  <li className="muted">Close match needs a cycle-averaged error under 20 percent and a correlation above 0.85. Moderate needs under 40 percent and above 0.6. The twin line is the average of {val.seeds} random seeds, because the clip is one random day.</li>
                </ul>
              </div>
              <p className="muted">
                {cap.origin === 'video'
                  ? perception?.satFlow && !perception.satFlow.isDefault
                    ? `The clip is your video. Queue discharge in it suggests a saturation flow of about ${Math.round(cap.trueSatFlowPerLane)} PCU per hour per lane, using ${params.lanes} inbound lane${params.lanes === 1 ? '' : 's'} per approach. If that is not the number of lanes on your road, change it on the Parameters page and analyse the video again.`
                    : 'The clip is your video. Not enough queue discharge was seen to measure its saturation flow, so the value shown is the current parameter and not a measurement.'
                  : `The clip is the sample junction's recorded run. It was produced with a saturation flow of about ${Math.round(cap.trueSatFlowPerLane)} PCU per hour per lane, so the best calibration is close to that.`}
              </p>
            </section>
            <div className="home-pair">
              <section className="panel">
                <Histogram title="Delay per vehicle in the clip" values={val.observedWaits} bins={10} xLabel="Seconds" height={190} xFormat={(n) => n.toFixed(0)} />
              </section>
              <section className="panel">
                <Histogram title="Delay per vehicle in the twin" values={val.simulatedWaits} bins={10} xLabel="Seconds" height={190} tone="old" xFormat={(n) => n.toFixed(0)} />
              </section>
            </div>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}

