import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { APPROACH_NAMES, APPROACHES, VEHICLE_CLASSES, type Scenario } from '../contracts';
import { SCENARIOS } from '../engine/params';
import { makeSim, profileFor, type RunSetup } from '../engine/experiment';
import { JunctionView } from '../components/JunctionView';
import { Scoreboard, Transport } from '../components/widgets';
import { LineChart, ScoreBar, Legend, type Series } from '../components/charts';
import { Button, NumberField, Segmented, SkeletonSquare, SliderField, Swap } from '../components/ui';
import { useSetup } from '../hooks/useSetup';
import { useRunner } from '../hooks/useRunner';
import { useApp } from '../store/app';
import { Footer, useCommands } from '../shell/Layout';
import { getSampleCapture } from '../engine/capture';
import { binArrivals, estimateDemand } from '../engine/demand';
import { validateTwin } from '../engine/twin';
import type { Sim } from '../engine/sim';

const STEPS = [
  { id: 'see', name: 'See', text: 'A detector finds every vehicle in every frame and a tracker keeps one identity per vehicle.' },
  { id: 'count', name: 'Count', text: 'Vehicles are counted when they cross a line, by class, so queues and arrivals are measured rather than guessed.' },
  { id: 'demand', name: 'Demand', text: 'Counts become arrival rates weighted by vehicle size, so a bus counts for more road than a two-wheeler.' },
  { id: 'twin', name: 'Twin', text: 'The junction is rebuilt as a simulation and checked against the queues the video actually showed.' },
  { id: 'decide', name: 'Decide', text: 'Each second the controller scores every phase and either holds or switches, with a plain reason.' },
  { id: 'prove', name: 'Prove', text: 'Both plans run on identical simulated traffic. Every difference comes from the plan alone.' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

export default function Home() {
  const [hs, setHs] = useState<'A' | 'B'>('A');
  const params = useApp((s) => s.params);
  const setup = useSetup(SCENARIOS[hs]);
  const profile = useMemo(() => profileFor(setup), [setup]);
  const factory = useCallback(
    (e: { t: number; approach: number }[]) => [makeSim({ ...setup, emergencies: e }, 'observed', 7, profile), makeSim({ ...setup, emergencies: e }, 'signaltwin', 7, profile)] as Sim[],
    [setup, profile],
  );
  const runner = useRunner(factory, params.horizon, [factory]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
    runner.seek(100);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const id = window.setTimeout(() => {
      runner.setSpeed(2);
      runner.play();
    }, 1500);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useCommands({ toggle: () => runner.toggle(), restart: () => runner.reset(), speed: (d) => runner.setSpeed(Math.max(1, Math.min(8, d > 0 ? runner.speed * 2 : runner.speed / 2))) });

  return (
    <>
      <section className="home-hero" aria-labelledby="home-title">
        <div className="stack">
          <h1 id="home-title" className="home-title">
            Test the signal plan before you change the signal.
          </h1>
          <p style={{ fontSize: 'var(--fs-18)' }}>
            Give SignalTwin a video of a junction. It rebuilds the junction as a simulation and runs your current timing and an adaptive timing on identical traffic.
          </p>
          <div className="row">
            <Link to="/console" className="btn btn-primary">
              Open the console
            </Link>
            <Link to="/setup" className="btn btn-secondary">
              Set up your junction
            </Link>
          </div>
          <p className="muted" style={{ fontSize: 'var(--fs-14)' }}>
            SignalTwin recommends a plan. It does not control any signal. The demo on this page runs on the built-in sample junction, so nothing here came from your video.
          </p>
        </div>
        <div className="home-demo">
          <div className="controls" role="group" aria-label="Demo controls">
            <div className="field">
              <span className="field-label">Scenario</span>
              <Segmented label="Scenario" value={hs} options={[{ value: 'A', label: 'A balanced' }, { value: 'B', label: 'B surge' }]} onChange={setHs} />
            </div>
            <Transport runner={runner} showScrub={false} />
          </div>
          <div className="home-pair">
            {ready ? (
              <>
                <div className="panel-asphalt on-asphalt" style={{ padding: 8 }}>
                  <JunctionView runner={runner} simIndex={0} intro caption="Current plan" overlays={{ labels: true }} />
                </div>
                <div className="panel-asphalt on-asphalt" style={{ padding: 8 }}>
                  <JunctionView runner={runner} simIndex={1} intro caption="SignalTwin plan" overlays={{ labels: true }} />
                </div>
              </>
            ) : (
              <>
                <SkeletonSquare />
                <SkeletonSquare />
              </>
            )}
          </div>
          <Scoreboard runner={runner} cells={4} tag="Sample run" />
        </div>
      </section>

      <Pipeline runner={runner} />
      <Honest />
      <Fairness />

      <section className="limits" aria-labelledby="limits-h">
        <div className="home-section-grid" style={{ maxWidth: 1180 }}>
          <h2 id="limits-h" style={{ fontSize: 'var(--fs-28)' }}>
            What it will not do
          </h2>
          <div className="stack">
            <p>SignalTwin recommends a signal plan. It does not connect to a signal controller and it does not need a live camera feed.</p>
            <p>The values for vehicle size and people per vehicle are assumptions taken from common practice. Tune them for your city on the Parameters page.</p>
            <p>The simulator models queues second by second. It does not model lane changes, car following or turning movements, so it compares plans well but does not predict exact travel times.</p>
            <p>Detection gets worse in dense traffic, at night and when two-wheelers weave between lanes. The Experiments page tests how the plan behaves when the controller misses up to 30 percent of vehicles.</p>
            <Link to="/method" style={{ color: 'var(--marking)' }}>
              Read the full method
            </Link>
          </div>
        </div>
      </section>
      <Footer />
    </>
  );
}

/* ---------------------------------------------------------------- pipeline */
function Pipeline({ runner }: { runner: ReturnType<typeof useRunner> }) {
  const [step, setStep] = useState<StepId>('see');
  const params = useApp((s) => s.params);
  const junction = useApp((s) => s.junction);
  const cap = useMemo(() => getSampleCapture(params, junction.observed), [params, junction.observed]);
  const est = useMemo(() => estimateDemand(binArrivals(cap.arrivals, cap.duration, params.binSeconds), params), [cap, params]);
  const twin = useMemo(() => validateTwin(params, cap, est.profile, junction.observed), [params, cap, est, junction.observed]);
  const simNew = runner.sims[1];
  const ev = simNew?.controller.lastEval;
  const counts = VEHICLE_CLASSES.map((c, i) => APPROACHES.map((_, ap) => cap.binned.counts[ap].reduce((s, b) => s + b[i], 0)));

  const demandSeries: Series[] = APPROACHES.map((a, ap) => ({
    id: a,
    label: APPROACH_NAMES[a],
    data: est.smoothPcu[ap].map((v, b) => [b * params.binSeconds, v] as [number, number]),
    tone: ap === 0 ? 'new' : ap === 1 ? 'old' : 'ink',
    dash: ap === 2 ? '6 4' : ap === 3 ? '2 4' : undefined,
  }));

  return (
    <section className="home-section" aria-labelledby="pipe-h">
      <div className="home-section-grid">
        <div className="stack">
          <h2 id="pipe-h" style={{ fontSize: 'var(--fs-28)' }}>
            How a measurement becomes a plan
          </h2>
          <p>Six steps run in order. Pick one to see the real screen it produces, drawn from the sample junction.</p>
        </div>
        <div className="stack">
          <div className="pipeline" role="tablist" aria-label="Pipeline steps">
            {STEPS.map((s, i) => (
              <button key={s.id} role="tab" aria-selected={step === s.id} className="pipe-step" onClick={() => setStep(s.id)}>
                <span className="pipe-n">Step {i + 1}</span>
                <span className="pipe-name">{s.name}</span>
              </button>
            ))}
          </div>
          <div className="panel" role="tabpanel" aria-live="polite" style={{ minHeight: 320 }}>
            <Swap id={step}>
            <p style={{ marginBottom: 12 }}>{STEPS.find((s) => s.id === step)?.text}</p>
            {step === 'see' && (
              <div style={{ maxWidth: 420 }} className="panel-asphalt on-asphalt">
                <JunctionView runner={runner} simIndex={1} overlays={{ boxes: true, ids: true, labels: false }} caption="Boxes show class, track number and confidence" />
              </div>
            )}
            {step === 'count' && (
              <div className="table-wrap">
                <table className="table" aria-label="Vehicles counted in the sample clip, by class and approach">
                  <thead>
                    <tr>
                      <th>Class</th>
                      {APPROACHES.map((a) => (
                        <th key={a} className="num">
                          {APPROACH_NAMES[a]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {VEHICLE_CLASSES.map((c, i) => (
                      <tr key={c}>
                        <td>{params.classes[c].label}</td>
                        {counts[i].map((n, ap) => (
                          <td key={ap} className="num">
                            {n}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {step === 'demand' && <LineChart title="Smoothed demand by approach, sample clip" series={demandSeries} height={230} xLabel="Time (s)" yLabel="PCU per second" xFormat={(n) => String(Math.round(n))} yFormat={(n) => n.toFixed(2)} unit="PCU per second" />}
            {step === 'twin' && (
              <div className="stack">
                <LineChart
                  title="Queue in the clip against queue in the twin"
                  series={[
                    { id: 'o', label: 'Clip', data: twin.times.map((t, i) => [t, twin.observed[i]] as [number, number]), tone: 'old', dash: '6 4' },
                    { id: 's', label: 'Twin', data: twin.times.map((t, i) => [t, twin.simulated[i]] as [number, number]), tone: 'new' },
                  ]}
                  height={220}
                  xLabel="Time (s)"
                  yLabel="Queue (PCU)"
                  xFormat={(n) => String(Math.round(n))}
                  yFormat={(n) => n.toFixed(0)}
                  unit="PCU"
                />
                <p>
                  <strong>{twin.verdict}.</strong> {twin.reasons[0]}
                </p>
              </div>
            )}
            {step === 'decide' && ev && (
              <div className="stack-sm">
                <p className="muted tnum">The controller's scores at second {simNew.t}. Press play above to see them change.</p>
                {ev.phases.map((p, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 70px', gap: 10, alignItems: 'center' }}>
                    <strong>{i === 0 ? 'NS' : 'EW'}</strong>
                    <ScoreBar q={p.q} e={p.e} a={p.a} max={Math.max(10, ...ev.phases.map((x) => x.score)) * 1.1} label={`Phase ${i === 0 ? 'NS' : 'EW'}`} />
                    <span className="tnum">{p.score.toFixed(1)}</span>
                  </div>
                ))}
                <Legend items={[{ label: 'Queue', pattern: 0 }, { label: 'Arriving soon', pattern: 1 }, { label: 'Waiting too long', pattern: 2 }]} />
                <p className="reason">{ev.reason || 'Press play to start.'}</p>
              </div>
            )}
            {step === 'prove' && <Scoreboard runner={runner} cells={4} tag="Sample run" />}
            </Swap>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- honest comparison */
function Honest() {
  const [mode, setMode] = useState<'video' | 'twin'>('twin');
  const [seed, setSeed] = useState(3);
  const base = useSetup(SCENARIOS.A);
  const data = useMemo(() => {
    const setup: RunSetup = { ...base, params: { ...base.params, horizon: 600 } };
    const profile = profileFor(setup);
    const mk = (kind: 'observed' | 'signaltwin') => {
      const sim = makeSim(setup, kind, seed, profile).run();
      const out: [number, number][] = [];
      for (let t = 0; t < 600; t += 5) out.push([t, sim.qSeries.reduce((s, q) => s + q[t], 0)]);
      return out;
    };
    return { old: mk('observed'), nw: mk('signaltwin') };
  }, [base, seed]);
  const series: Series[] =
    mode === 'video'
      ? [{ id: 'o', label: 'What the video shows', data: data.old, tone: 'old' }]
      : [
          { id: 'o', label: 'Current plan', data: data.old, tone: 'old', dash: '6 4' },
          { id: 'n', label: 'SignalTwin plan', data: data.nw, tone: 'new' },
        ];
  return (
    <section className="home-section" aria-labelledby="honest-h">
      <div className="home-section-grid">
        <div className="stack">
          <h2 id="honest-h" style={{ fontSize: 'var(--fs-28)' }}>
            Why the comparison is honest
          </h2>
          <p>A video only shows what happened under the signal that was already installed. It cannot show what a different plan would have done. The twin can, because it replays the same traffic under both.</p>
        </div>
        <div className="stack">
          <div className="row">
            <Segmented label="What is shown" value={mode} options={[{ value: 'video', label: 'Video only' }, { value: 'twin', label: 'Video plus twin' }]} onChange={setMode} />
            <div style={{ width: 150 }}>
              <NumberField label="Traffic seed" value={seed} min={1} max={999} onChange={(n) => setSeed(Math.round(n))} />
            </div>
            <Button variant="secondary" onClick={() => setSeed(Math.floor(Math.random() * 998) + 1)}>
              New traffic
            </Button>
          </div>
          <div className="panel">
            <LineChart title="Total queue in the first ten minutes" series={series} height={240} xLabel="Time (s)" yLabel="Queue (PCU)" xFormat={(n) => String(Math.round(n))} yFormat={(n) => n.toFixed(0)} unit="PCU" />
          </div>
          <p aria-live="polite">
            {mode === 'video'
              ? 'One line. It shows only the plan that was running when the camera recorded. There is nothing to compare it with.'
              : 'Two lines on the same seeded traffic. Change the seed and both lines move together, because the arrivals are identical. Sample run.'}
          </p>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- fairness */
function Fairness() {
  const [mult, setMult] = useState(2.4);
  const base = useSetup(SCENARIOS.A);
  const cap = base.params.fairnessCap;
  const out = useMemo(() => {
    const sc: Scenario = { ...SCENARIOS.A, id: 'custom', name: 'Surge demo', surges: [{ approach: 0, from: 150, to: 700, mult }] };
    const setup: RunSetup = { ...base, params: { ...base.params, horizon: 900 }, scenario: sc };
    const sim = makeSim(setup, 'signaltwin', 5, profileFor(setup)).run();
    const east: [number, number][] = [];
    const west: [number, number][] = [];
    for (let t = 0; t < 900; t += 2) {
      east.push([t, sim.redSeries[2][t]]);
      west.push([t, sim.redSeries[3][t]]);
    }
    return { east, west, longest: Math.max(...sim.maxRed), forced: sim.decisions.filter((d) => d.rule === 'fairness').length, maxGreen: sim.decisions.filter((d) => d.rule === 'maxgreen').length };
  }, [base, mult]);
  return (
    <section className="home-section" aria-labelledby="fair-h">
      <div className="home-section-grid">
        <div className="stack">
          <h2 id="fair-h" style={{ fontSize: 'var(--fs-28)' }}>
            Fairness you can check
          </h2>
          <p>Raise the surge on the North approach. The East and West roads still get green before the cap of {cap} seconds, because a guard forces the switch when their red time gets close.</p>
          <SliderField label="North surge" value={mult} min={1} max={3.2} step={0.2} format={(n) => `${n.toFixed(1)}x`} onChange={setMult} />
        </div>
        <div className="stack">
          <div className="panel">
            <LineChart
              title="Red time on East and West during the surge"
              series={[
                { id: 'e', label: 'East red time', data: out.east, tone: 'new', step: true },
                { id: 'w', label: 'West red time', data: out.west, tone: 'old', dash: '6 4', step: true },
              ]}
              refLines={[{ y: cap, label: `Cap ${cap} s` }]}
              yDomain={[0, cap * 1.15]}
              height={230}
              xLabel="Time (s)"
              yLabel="Seconds without green"
              xFormat={(n) => String(Math.round(n))}
              yFormat={(n) => n.toFixed(0)}
              unit="s"
            />
          </div>
          <p aria-live="polite" className="tnum">
            Longest red anywhere: <strong>{out.longest} s</strong> against a cap of {cap} s. The guard forced {out.forced} switch{out.forced === 1 ? '' : 'es'} and the maximum green forced {out.maxGreen}. Sample run.
          </p>
        </div>
      </div>
    </section>
  );
}

