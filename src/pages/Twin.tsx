import { useCallback, useEffect, useMemo, useState } from 'react';
import { JunctionView } from '../components/JunctionView';
import { Transport } from '../components/widgets';
import { Histogram, LineChart } from '../components/charts';
import { Badge, Button, NumberField, PageHeader, SkeletonChart, toast } from '../components/ui';
import { useApp } from '../store/app';
import { useRunner } from '../hooks/useRunner';
import { useCommands, Footer } from '../shell/Layout';
import { useRunStatus } from '../shell/status';
import { CAPTURE_DURATION, getSampleCapture } from '../engine/capture';
import { binArrivals, estimateDemand } from '../engine/demand';
import { validateTwin } from '../engine/twin';
import { DEFAULT_OPTIONS, NO_NOISE } from '../engine/params';
import { Sim } from '../engine/sim';

export default function Twin() {
  const params = useApp((s) => s.params);
  const setParams = useApp((s) => s.setParams);
  const junction = useApp((s) => s.junction);
  const calibrated = useApp((s) => s.calibrated);
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

  const local = useMemo(() => ({ ...params, satFlowPerLane: sat, startupLost: startup, travelMin: tMin, travelMax: Math.max(tMin, tMax), horizon: CAPTURE_DURATION }), [params, sat, startup, tMin, tMax]);
  const cap = useMemo(() => getSampleCapture(params, junction.observed), [params, junction.observed]);
  const est = useMemo(() => estimateDemand(binArrivals(cap.arrivals, cap.duration, params.binSeconds), local), [cap, params.binSeconds, local]);
  const val = useMemo(() => validateTwin(local, cap, est.profile, junction.observed, seed), [local, cap, est, junction.observed, seed]);

  const factory = useCallback(
    () => [
      new Sim({ params: local, demand: est.profile, kind: 'observed', options: DEFAULT_OPTIONS, seed, horizon: CAPTURE_DURATION, noise: NO_NOISE, emergencies: [], observed: junction.observed }),
    ],
    [local, est, seed, junction.observed],
  );
  const runner = useRunner(factory, CAPTURE_DURATION, [factory]);
  useEffect(() => {
    runner.seek(150);
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
              <p className="muted">The clip is the sample junction's recorded run. It was produced with a saturation flow of about {Math.round(cap.trueSatFlowPerLane)} PCU per hour per lane, so the best calibration is close to that.</p>
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

