import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { APPROACH_NAMES, APPROACHES, VEHICLE_CLASSES, METRIC_KEYS, type ComparisonResult, type ControllerKind, type Scenario } from '../contracts';
import { SCENARIOS, noiseAt, phaseName } from '../engine/params';
import { makeSim, profileFor, type RunSetup } from '../engine/experiment';
import { JunctionView, type HighlightRef } from '../components/JunctionView';
import { PhaseTimeline, Scoreboard, Transport } from '../components/widgets';
import { LineChart, type Series } from '../components/charts';
import { Button, DataTable, Meter, PageHeader, Segmented, SliderField, Tabs, Toggle, useMedia, toast, SelectField, type Column } from '../components/ui';
import { useApp } from '../store/app';
import { useSetup } from '../hooks/useSetup';
import { useRunner } from '../hooks/useRunner';
import { useCommands } from '../shell/Layout';
import { useRunStatus } from '../shell/status';
import { startExperiment, type Job } from '../engine/workerClient';
import { METRIC_LABELS } from '../engine/metrics';
import { downloadText, fmtStat, mmss, toCsv } from '../lib/util';
import { Footer } from '../shell/Layout';
import type { Sim } from '../engine/sim';

type Baseline = 'observed' | 'webster' | 'vac';
const BASE_LABEL: Record<Baseline, string> = { observed: 'Current plan', webster: 'Webster plan', vac: 'VAC plan' };
const ap4 = [0, 1, 2, 3];

export default function Console() {
  const params = useApp((s) => s.params);
  const options = useApp((s) => s.options);
  const setParams = useApp((s) => s.setParams);
  const setOptions = useApp((s) => s.setOptions);
  const setObjective = useApp((s) => s.setObjective);
  const scenarioId = useApp((s) => s.scenarioId);
  const setScenario = useApp((s) => s.setScenario);
  const seed = useApp((s) => s.seed);
  const setSeed = useApp((s) => s.setSeed);
  const addRun = useApp((s) => s.addRun);
  const setStatus = useRunStatus((s) => s.set);

  const [sp, setSp] = useSearchParams();
  const [scKey, setScKey] = useState<'A' | 'B' | 'custom'>(scenarioId);
  const [mult, setMult] = useState([1, 1, 1, 1]);
  const [noise, setNoise] = useState(0);
  const [baseline, setBaseline] = useState<Baseline>('observed');
  const [emAp, setEmAp] = useState('2');
  const [tab, setTab] = useState<'live' | 'decision' | 'proof'>('proof');
  const [split, setSplit] = useState(36);
  const [loadOpen, setLoadOpen] = useState(false);
  const narrow = useMedia('(max-width: 1279px)');
  const highlight = useRef<HighlightRef['current']>(null) as HighlightRef;
  const [hoverLog, setHoverLog] = useState<number | null>(null);

  // URL state in, once
  const urlRead = useRef(false);
  useEffect(() => {
    if (urlRead.current) return;
    urlRead.current = true;
    const s = sp.get('scenario');
    if (s === 'A' || s === 'B') {
      setScKey(s);
      setScenario(s);
    }
    const sd = Number(sp.get('seed'));
    if (sd >= 1 && sd <= 999) setSeed(Math.round(sd));
    const m = sp.get('mode');
    if (m === 'people' || m === 'vehicles') setObjective(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scenario: Scenario = useMemo(
    () => (scKey === 'custom' ? { ...SCENARIOS.A, id: 'custom', name: 'Custom load', multipliers: mult } : SCENARIOS[scKey]),
    [scKey, mult],
  );
  const noiseSpec = useMemo(() => noiseAt(noise), [noise]);
  const setup: RunSetup = useSetup(scenario, { noise: noiseSpec });
  const profile = useMemo(() => profileFor(setup), [setup]);

  const factory = useCallback(
    (emergencies: { t: number; approach: number }[]) => {
      const s: RunSetup = { ...setup, emergencies };
      return [makeSim(s, baseline, seed, profile), makeSim(s, 'signaltwin', seed, profile)] as Sim[];
    },
    [setup, profile, seed, baseline],
  );
  const runner = useRunner(factory, params.horizon, [factory]);
  const simOld = runner.sims[0];
  const simNew = runner.sims[1];

  // URL state out, on change
  useEffect(() => {
    const next = new URLSearchParams(sp);
    next.set('scenario', scKey === 'custom' ? 'A' : scKey);
    next.set('seed', String(seed));
    next.set('mode', options.objective);
    if (!runner.playing) next.set('t', String(runner.t));
    setSp(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scKey, seed, options.objective, runner.playing]);
  const tParam = useRef(Number(sp.get('t')) || 0);
  useEffect(() => {
    if (tParam.current > 0) {
      runner.seek(tParam.current);
      tParam.current = 0;
    } else runner.seek(120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setStatus(runner.playing ? `Playing at ${runner.speed}x, ${mmss(runner.t)}` : runner.ended ? 'Run finished' : `Paused at ${mmss(runner.t)}`);
  }, [runner.playing, runner.speed, runner.t, runner.ended, setStatus]);
  useEffect(() => () => setStatus('Idle'), [setStatus]);

  useCommands({
    toggle: () => runner.toggle(),
    speed: (d) => runner.setSpeed(Math.max(1, Math.min(8, d > 0 ? runner.speed * 2 : runner.speed / 2))),
    restart: () => runner.reset(),
    emergency: () => sendEmergency(2),
  });
  const sendEmergency = (ap: number) => {
    runner.triggerEmergency(ap);
    toast(`Emergency vehicle sent on the ${APPROACH_NAMES[APPROACHES[ap]]} approach.`);
  };

  // 20 seed comparison
  const [job, setJob] = useState<Job | null>(null);
  const [prog, setProg] = useState<{ done: number; total: number; label: string } | null>(null);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  useEffect(() => () => job?.cancel(), [job]);
  const runSeeds = async () => {
    const j = startExperiment({ type: 'compare', setup, kinds: ['observed', 'webster', 'vac', 'signaltwin'], seeds: params.seeds }, (p) => {
      setProg(p);
      setStatus(`Running ${p.done} of ${p.total} seeds`);
    });
    setJob(j);
    setProg({ done: 0, total: params.seeds, label: 'Starting' });
    try {
      const r = await j.promise;
      if (r.type === 'compare') {
        setResult(r.result);
        addRun({ id: `run-${Date.now()}`, kind: 'compare', label: `${scenario.name}, console`, at: new Date().toISOString(), scenarioId: scenario.id, seeds: r.result.seeds, data: r.result });
        toast(`Compared ${r.result.seeds} seeds. Results are below and in Experiments.`);
      }
    } catch (e) {
      if ((e as Error).name !== 'Error' && (e as Error).message === 'cancelled') toast('Comparison cancelled.');
      else if ((e as Error).message !== 'cancelled') toast(`The comparison failed: ${(e as Error).message}`, 'error');
      else toast('Comparison cancelled.');
    } finally {
      setJob(null);
      setProg(null);
      setStatus('Idle');
    }
  };

  const downloadRun = () => {
    if (!simNew) return;
    const rows: (string | number)[][] = [['time_s', 'plan', 'action', 'rule', 'reason']];
    for (const [name, sim] of [['SignalTwin plan', simNew], ['Current plan', simOld]] as const) {
      for (const d of sim.decisions) rows.push([d.t, name, d.action, d.rule, d.reason]);
    }
    rows.push([]);
    rows.push(['metric', 'current_plan', 'signaltwin_plan']);
    import('../engine/metrics').then(({ computeMetrics }) => {
      const a = computeMetrics(simOld);
      const b = computeMetrics(simNew);
      for (const k of METRIC_KEYS) rows.push([METRIC_LABELS[k].label, a[k].toFixed(2), b[k].toFixed(2)]);
      downloadText(`signaltwin-console-seed${seed}.csv`, toCsv(rows));
      toast('Run downloaded as CSV.');
    });
  };

  const lastDecision = simNew?.decisions[simNew.decisions.length - 1];
  const ev = simNew?.controller.lastEval;
  const st = simNew?.signal;
  const phases = simNew?.phases ?? [];
  const log = (simNew?.decisions ?? []).slice(-40).reverse();

  const counts = useMemo(() => {
    const c = ap4.map(() => VEHICLE_CLASSES.map(() => 0));
    if (!simNew) return c;
    for (let t = 0; t < simNew.t; t++) for (const v of simNew.arrivals[t] ?? []) c[v.ap][VEHICLE_CLASSES.indexOf(v.cls)]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.version]);

  const queueSeries = useMemo(() => {
    const mk = (sim: Sim | undefined): [number, number][] => {
      if (!sim) return [];
      const out: [number, number][] = [];
      const n = sim.qSeries[0].length;
      for (let t = 0; t < n; t += 5) out.push([t, sim.qSeries.reduce((s, q) => s + (q[t] ?? 0), 0)]);
      return out;
    };
    const old: Series = { id: 'old', label: BASE_LABEL[baseline], data: mk(simOld), tone: 'old', dash: '6 4' };
    const nw: Series = { id: 'new', label: 'SignalTwin plan', data: mk(simNew), tone: 'new' };
    return [old, nw];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.version]);

  const onLogHover = (ap: number[] | null, idx: number | null) => {
    setHoverLog(idx);
    if (ap && ap.length) highlight.current = { ap: ap[0], at: performance.now() };
  };

  const panelLive = (
    <section className="panel-asphalt on-asphalt" aria-labelledby="h-live">
      <div className="panel-head">
        <h2 id="h-live">Live analysis</h2>
        <span className="muted" style={{ color: 'var(--marking-muted)' }}>SignalTwin run, seed {seed}</span>
      </div>
      <JunctionView runner={runner} simIndex={1} overlays={{ queueZones: true, boxes: true, counts: true, ids: true, labels: true }} highlight={highlight} caption="What the camera sees: detections, counting lines, queue zones" />
      <h3 style={{ margin: '16px 0 8px' }}>Vehicles counted so far</h3>
      <table className="count-table" aria-label="Vehicles counted per approach and class">
        <thead>
          <tr>
            <th scope="col">Approach</th>
            {VEHICLE_CLASSES.map((c) => (
              <th key={c} scope="col" title={params.classes[c].label}>
                {c === 'twoWheeler' ? '2W' : c === 'autoRickshaw' ? 'Auto' : c === 'truck' ? 'Truck' : c === 'bus' ? 'Bus' : 'Car'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ap4.map((ap) => (
            <tr key={ap}>
              <th scope="row">{APPROACH_NAMES[APPROACHES[ap]]}</th>
              {counts[ap].map((n, i) => (
                <td key={i}>{n}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <h3 style={{ margin: '16px 0 8px' }}>Queue pressure</h3>
      <div className="stack-sm">
        {ap4.map((ap) => {
          const q = simNew?.qSeries[ap][simNew.qSeries[ap].length - 1] ?? 0;
          return (
            <div key={ap} style={{ display: 'grid', gridTemplateColumns: '64px 1fr 72px', gap: 8, alignItems: 'center' }}>
              <span>{APPROACH_NAMES[APPROACHES[ap]]}</span>
              <Meter value={q} max={40} label={`${APPROACH_NAMES[APPROACHES[ap]]} queue in PCU`} />
              <span className="tnum" style={{ textAlign: 'right' }}>
                {q.toFixed(1)} PCU
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );

  const panelDecision = (
    <section className="panel" aria-labelledby="h-dec">
      <div className="panel-head">
        <h2 id="h-dec">Decision</h2>
        <span className="badge badge-plain">SignalTwin plan</span>
      </div>
      {st && (
        <div className="decision-now">
          <div className="phase-big">
            {phaseName(phases[st.phase])} {st.stage === 'green' ? 'green' : st.stage === 'yellow' ? 'yellow' : 'all red'}
          </div>
          <div className="muted tnum">
            {st.stage === 'green'
              ? `${st.stageT} s into this green. Minimum ${params.minGreen} s, maximum ${params.maxGreen} s, so at most ${Math.max(0, params.maxGreen - st.stageT)} s left.`
              : st.stage === 'yellow'
                ? `Yellow, ${params.yellow - st.stageT} s left, then ${params.allRed} s all red.`
                : `All red, ${params.allRed - st.stageT} s left, then ${phaseName(phases[st.next])} green.`}
          </div>
          <div className="reason" aria-live="polite">
            <strong>Latest reason</strong>
            <p>{ev?.reason || lastDecision?.reason || 'Waiting for the first decision.'}</p>
          </div>
        </div>
      )}
      <h3 style={{ margin: '16px 0 8px' }}>Red time against the cap</h3>
      <div className="stack-sm">
        {ap4.map((ap) => (
          <div key={ap} style={{ display: 'grid', gridTemplateColumns: '64px 1fr 56px', gap: 8, alignItems: 'center' }}>
            <span>{APPROACH_NAMES[APPROACHES[ap]]}</span>
            <Meter value={simNew?.red[ap] ?? 0} max={Math.max(params.fairnessCap, 1) * 1.1} cap={params.fairnessCap} label={`${APPROACH_NAMES[APPROACHES[ap]]} red time against the ${params.fairnessCap} second cap`} />
            <span className="tnum" style={{ textAlign: 'right' }}>
              {simNew?.red[ap] ?? 0} s
            </span>
          </div>
        ))}
      </div>
      <h3 style={{ margin: '16px 0 8px' }}>Signal timeline</h3>
      {simNew && <PhaseTimeline sim={simNew} />}
      <div className="panel-head" style={{ margin: '16px 0 8px' }}>
        <h3>Decision log</h3>
        <span className="muted">{log.length} recent</span>
      </div>
      <ul className="log" aria-label="Decision log, newest first" tabIndex={0}>
        {log.length === 0 && <li className="log-item muted">No decisions yet. Press play.</li>}
        {log.map((d, i) => (
          <li key={`${d.t}-${i}`} className={`log-item ${i === 0 ? 'log-enter' : ''}`} onMouseEnter={() => onLogHover(d.approaches, i)} onMouseLeave={() => onLogHover(null, null)} style={hoverLog === i ? { background: 'var(--surface-2)' } : undefined}>
            <span className="log-t">{mmss(d.t)}</span>
            <span>
              <b>{d.action}.</b> {d.reason}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );

  const panelProof = (
    <section className="panel-asphalt on-asphalt" aria-labelledby="h-proof" style={{ background: 'var(--surface)', color: 'var(--ink)' }}>
      <div className="panel-head">
        <h2 id="h-proof">Proof</h2>
        <span className="muted">Same traffic, same seed {seed}</span>
      </div>
      <div className="home-pair">
        <div className="panel-asphalt on-asphalt" style={{ padding: 8 }}>
          <JunctionView runner={runner} simIndex={0} overlays={{ labels: true }} caption={BASE_LABEL[baseline]} highlight={undefined} />
        </div>
        <div className="panel-asphalt on-asphalt" style={{ padding: 8 }}>
          <JunctionView runner={runner} simIndex={1} overlays={{ labels: true }} caption="SignalTwin plan" highlight={highlight} />
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <Scoreboard runner={runner} cells={5} oldLabel={BASE_LABEL[baseline]} />
      </div>
      <div style={{ marginTop: 16 }}>
        <LineChart title="Total queue over time" series={queueSeries} height={200} xLabel="Time (s)" yLabel="Queue (PCU)" unit="PCU" xFormat={(n) => String(Math.round(n))} yFormat={(n) => n.toFixed(0)} cursor={runner.t} />
      </div>
    </section>
  );

  const onSplitKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setSplit((v) => Math.max(25, v - 3));
    if (e.key === 'ArrowRight') setSplit((v) => Math.min(60, v + 3));
  };
  const dragging = useRef(false);

  return (
    <>
      <div className="page page-wide">
        <PageHeader title="Console" lede="Watch the current plan and the SignalTwin plan handle identical traffic, see why each signal change happened, and run the comparison across 20 seeds." />

        <div className="controls" role="group" aria-label="Run controls">
          <div className="field">
            <span className="field-label">Scenario</span>
            <Segmented
              label="Scenario"
              value={scKey}
              options={[
                { value: 'A', label: 'A balanced' },
                { value: 'B', label: 'B surge' },
                { value: 'custom', label: 'Custom' },
              ]}
              onChange={(v) => {
                setScKey(v);
                if (v !== 'custom') setScenario(v);
              }}
            />
          </div>
          <div className="field">
            <span className="field-label">Compare against</span>
            <Segmented label="Baseline plan" value={baseline} options={[{ value: 'observed', label: 'Observed plan' }, { value: 'webster', label: 'Webster plan' }, { value: 'vac', label: 'VAC' }]} onChange={setBaseline} />
          </div>
          <div className="field">
            <span className="field-label">Objective</span>
            <Segmented label="Objective" value={options.objective} options={[{ value: 'vehicles', label: 'Vehicles' }, { value: 'people', label: 'People' }]} onChange={setObjective} />
          </div>
          <SliderField label="Fairness cap" value={params.fairnessCap} min={30} max={120} step={5} unit="s" onChange={(n) => setParams({ fairnessCap: n })} />
          <SliderField label="Detection noise" value={noise} min={0} max={30} step={10} unit="%" onChange={setNoise} />
          <div className="field">
            <label className="field-label" htmlFor="seed-in">Seed</label>
            <input id="seed-in" className="input" type="number" min={1} max={999} value={seed} onChange={(e) => setSeed(Math.max(1, Math.min(999, Math.round(Number(e.target.value) || 1))))} style={{ width: 90 }} />
          </div>
          <Toggle label="Platoon look-ahead" checked={options.lookahead} onChange={(v) => setOptions({ lookahead: v })} />
          <Toggle label="Clear standing queue first" checked={options.queueClearance} onChange={(v) => setOptions({ queueClearance: v })} hint="Hold green until the vehicles that were in the queue zone when it started have left." />
          <div className="field">
            <span className="field-label">Emergency vehicle</span>
            <div className="row">
              <select className="select" aria-label="Emergency approach" value={emAp} onChange={(e) => setEmAp(e.target.value)} style={{ width: 110 }}>
                {APPROACHES.map((a, i) => (
                  <option key={a} value={i}>
                    {APPROACH_NAMES[a]}
                  </option>
                ))}
              </select>
              <Button variant="secondary" icon="siren" onClick={() => sendEmergency(Number(emAp))} disabled={!options.emergencyPriority} disabledReason="Emergency priority is switched off in Controller.">
                Send
              </Button>
            </div>
          </div>
          <Button variant="quiet" onClick={() => setLoadOpen((v) => !v)} aria-expanded={loadOpen}>
            {loadOpen ? 'Hide load by approach' : 'Load by approach'}
          </Button>
        </div>
        {loadOpen && (
          <div className="controls" style={{ marginTop: 1 }} role="group" aria-label="Load by approach">
            {ap4.map((ap) => (
              <SliderField
                key={ap}
                label={`${APPROACH_NAMES[APPROACHES[ap]]} load`}
                value={mult[ap]}
                min={0.4}
                max={2.6}
                step={0.1}
                format={(n) => `${n.toFixed(1)}x`}
                onChange={(n) => {
                  setMult((m) => m.map((x, i) => (i === ap ? n : x)));
                  setScKey('custom');
                }}
              />
            ))}
          </div>
        )}
        <div className="panel" style={{ marginTop: 1 }}>
          <Transport runner={runner} />
        </div>

        <div style={{ marginTop: 'var(--s-3)' }}>
          {narrow ? (
            <>
              <Tabs
                label="Console panels"
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: 'live', label: 'Live analysis' },
                  { id: 'decision', label: 'Decision' },
                  { id: 'proof', label: 'Proof' },
                ]}
              />
              <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} style={{ marginTop: 8 }}>
                {tab === 'live' ? panelLive : tab === 'decision' ? panelDecision : panelProof}
              </div>
            </>
          ) : (
            <div className="console-grid" style={{ ['--gcols' as string]: `minmax(260px, 3.6fr) minmax(280px, ${split / 8}fr) 12px minmax(380px, ${(100 - split) / 8}fr)` }}>
              {panelLive}
              {panelDecision}
              <div
                className="splitter"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize decision and proof panels"
                aria-valuenow={split}
                aria-valuemin={25}
                aria-valuemax={60}
                tabIndex={0}
                onKeyDown={onSplitKey}
                onPointerDown={(e) => {
                  dragging.current = true;
                  (e.target as HTMLElement).setPointerCapture(e.pointerId);
                }}
                onPointerUp={() => (dragging.current = false)}
                onPointerMove={(e) => {
                  if (!dragging.current) return;
                  const grid = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                  const rel = ((e.clientX - grid.left) / grid.width) * 100;
                  setSplit(Math.max(25, Math.min(60, Math.round(rel - 25))));
                }}
              />
              {panelProof}
            </div>
          )}
        </div>

        <section className="panel result-strip" aria-labelledby="h-seeds">
          <div className="panel-head">
            <h2 id="h-seeds">Twenty-seed comparison</h2>
            <div className="row">
              <Button variant="primary" onClick={runSeeds} loading={!!job} disabled={!!job}>
                Run {params.seeds} seeds
              </Button>
              {job && (
                <Button variant="secondary" onClick={() => job.cancel()}>
                  Cancel
                </Button>
              )}
              <Button variant="secondary" icon="download" onClick={downloadRun}>
                Download this run
              </Button>
            </div>
          </div>
          {prog && (
            <div className="stack-sm" aria-live="polite">
              <Meter value={prog.done} max={prog.total} label="Seed progress" />
              <span className="muted tnum">{prog.label}</span>
            </div>
          )}
          {!result && !prog && <p className="muted">No comparison yet. Run {params.seeds} seeds to get mean delay, fairness and throughput with 95 percent confidence intervals for the observed plan, the Webster plan and SignalTwin.</p>}
          {result && <ResultTable result={result} />}
          {result && (
            <p style={{ marginTop: 12 }}>
              <Link to="/experiments">Open these results in Experiments</Link>
            </p>
          )}
        </section>
      </div>
      <Footer />
    </>
  );
}

const KIND_LABEL: Record<ControllerKind, string> = { observed: 'Observed plan', webster: 'Webster plan', vac: 'VAC plan', signaltwin: 'SignalTwin plan' };

export function ResultTable({ result }: { result: ComparisonResult }) {
  const kinds = (Object.keys(result.stats) as ControllerKind[]).sort((a, b) => ['observed', 'webster', 'vac', 'signaltwin'].indexOf(a) - ['observed', 'webster', 'vac', 'signaltwin'].indexOf(b));
  const keys = METRIC_KEYS;
  type Row = (typeof keys)[number];
  const cols: Column<Row>[] = [
    { key: 'm', label: 'Metric', render: (k) => `${METRIC_LABELS[k].label}${METRIC_LABELS[k].unit ? `, ${METRIC_LABELS[k].unit}` : ''}`, sort: (k) => METRIC_LABELS[k].label },
    ...kinds.map<Column<Row>>((kind) => ({
      key: kind,
      label: KIND_LABEL[kind],
      num: true,
      render: (k) => fmtStat(k, result.stats[kind]![k]),
    })),
    {
      key: 'delta',
      label: 'SignalTwin against Webster (paired)',
      num: true,
      render: (k) => {
        const p = result.paired.signaltwin?.[k];
        if (!p) return 'none';
        const good = METRIC_LABELS[k].better === 'lower' ? p.mean < 0 : p.mean > 0;
        const sig = Math.abs(p.mean) > p.ci;
        return (
          <span className={sig ? (good ? 'delta-good' : 'delta-bad') : 'muted'}>
            {p.pct > 0 ? '+' : ''}
            {p.pct.toFixed(1)} percent{sig ? '' : ', within noise'}
          </span>
        );
      },
    },
  ];
  return (
    <>
      <DataTable rows={keys.slice()} columns={cols} rowKey={(k) => k} ariaLabel={`Comparison of ${result.seeds} seeds, mean and 95 percent confidence interval`} />
      <p className="muted" style={{ marginTop: 8 }}>
        Your run, {result.seeds} seeds, {Math.round(result.horizon / 60)} minutes each. Same seeds for every plan. Values are mean plus or minus the 95 percent confidence interval.
      </p>
    </>
  );
}

