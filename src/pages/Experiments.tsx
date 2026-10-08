import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { METRIC_KEYS, type ComparisonResult, type ControllerKind, type Scenario } from '../contracts';
import { SCENARIOS } from '../engine/params';
import { useApp, type RunRecord } from '../store/app';
import { useSetup } from '../hooks/useSetup';
import { api } from '../api';
import type { Job } from '../engine/workerClient';
import type { AblationRow, NoiseRow, ExperimentRequest } from '../engine/experiment';
import { METRIC_LABELS } from '../engine/metrics';
import { LineChart, StripPlot, type Series } from '../components/charts';
import { Button, DataTable, EmptyState, Meter, NumberField, PageHeader, SliderField, Swap, Tabs, toast, type Column } from '../components/ui';
import { ResultTable } from './Console';
import { downloadText, fmtStat, isGood, toCsv } from '../lib/util';
import { useRunStatus } from '../shell/status';
import { Footer } from '../shell/Layout';

type Tab = 'scenarios' | 'ablation' | 'noise' | 'fairness';
const KINDS: ControllerKind[] = ['observed', 'webster', 'vac', 'signaltwin'];
const KIND_LABEL: Record<ControllerKind, string> = { observed: 'Observed plan', webster: 'Webster plan', vac: 'VAC plan', signaltwin: 'SignalTwin plan' };

export default function Experiments() {
  const params = useApp((s) => s.params);
  const runs = useApp((s) => s.runs);
  const addRun = useApp((s) => s.addRun);
  const clearRuns = useApp((s) => s.clearRuns);
  const setStatus = useRunStatus((s) => s.set);
  const [tab, setTab] = useState<Tab>('scenarios');
  const [scA, setScA] = useState<Scenario>(SCENARIOS.A);
  const [scB, setScB] = useState<Scenario>(SCENARIOS.B);
  const [view, setView] = useState<'A' | 'B'>('A');
  const [cmp, setCmp] = useState<{ A?: ComparisonResult; B?: ComparisonResult }>({});
  const [abl, setAbl] = useState<{ rows: AblationRow[]; seeds: number } | null>(null);
  const [noise, setNoise] = useState<{ rows: NoiseRow[]; seeds: number } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [prog, setProg] = useState<{ done: number; total: number; label: string } | null>(null);
  const [seeds, setSeeds] = useState(params.seeds);
  const [restored, setRestored] = useState<string | null>(null);

  const setupA = useSetup(scA);
  const setupB = useSetup(scB);
  const setupFor = (id: 'A' | 'B') => (id === 'A' ? setupA : setupB);

  // restore the newest saved runs on first load
  useEffect(() => {
    const latest = (k: RunRecord['kind'], sc?: string) => runs.find((r) => r.kind === k && (!sc || r.scenarioId === sc));
    const a = latest('compare', 'A');
    const b = latest('compare', 'B');
    setCmp({ A: a?.data as ComparisonResult | undefined, B: b?.data as ComparisonResult | undefined });
    const ab = latest('ablation');
    if (ab) setAbl({ rows: (ab.data as { rows: AblationRow[] }).rows, seeds: ab.seeds });
    const no = latest('noise');
    if (no) setNoise({ rows: (no.data as { rows: NoiseRow[] }).rows, seeds: no.seeds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => job?.cancel(), [job]);

  const run = async (req: ExperimentRequest, label: string, after: (r: Awaited<Job['promise']>) => void) => {
    const j = api.runExperiment(req, (p) => {
      setProg(p);
      setStatus(`${p.label}`);
    });
    setJob(j);
    setProg({ done: 0, total: 1, label: 'Starting' });
    try {
      const r = await j.promise;
      after(r);
      toast(`${label} finished.`);
    } catch (e) {
      if ((e as Error).message === 'cancelled') toast(`${label} cancelled.`);
      else toast(`${label} failed: ${(e as Error).message}`, 'error');
    } finally {
      setJob(null);
      setProg(null);
      setStatus('Idle');
    }
  };

  const runScenarios = async (which: ('A' | 'B')[]) => {
    for (const id of which) {
      await run({ type: 'compare', setup: setupFor(id), kinds: KINDS, seeds }, `Scenario ${id}`, (r) => {
        if (r.type !== 'compare') return;
        setCmp((c) => ({ ...c, [id]: r.result }));
        addRun({ id: `run-${Date.now()}-${id}`, kind: 'compare', label: `Scenario ${id}, experiments`, at: new Date().toISOString(), scenarioId: id, seeds: r.result.seeds, data: r.result });
      });
    }
    setView(which[which.length - 1]);
  };
  const runAblation = () =>
    run({ type: 'ablation', setup: setupB, seeds }, 'Ablation', (r) => {
      if (r.type !== 'ablation') return;
      setAbl({ rows: r.rows, seeds: r.seeds });
      addRun({ id: `run-${Date.now()}`, kind: 'ablation', label: 'Ablation, Scenario B', at: new Date().toISOString(), scenarioId: 'B', seeds: r.seeds, data: { rows: r.rows } });
    });
  const runNoise = () =>
    run({ type: 'noise', setup: setupA, levels: [0, 10, 20, 30], seeds }, 'Noise test', (r) => {
      if (r.type !== 'noise') return;
      setNoise({ rows: r.rows, seeds: r.seeds });
      addRun({ id: `run-${Date.now()}`, kind: 'noise', label: 'Noise test, Scenario A', at: new Date().toISOString(), scenarioId: 'A', seeds: r.seeds, data: { rows: r.rows } });
    });

  const result = cmp[view];
  const busy = !!job;
  const progress = prog ? <div className="stack-sm" aria-live="polite"><Meter value={prog.done} max={Math.max(1, prog.total)} label="Progress" /><span className="muted tnum">{prog.label}</span></div> : null;
  const runBar = (onRun: () => void, text: string) => (
    <div className="row">
      <Button variant="primary" onClick={onRun} loading={busy} disabled={busy}>
        {text}
      </Button>
      {busy && (
        <Button variant="secondary" onClick={() => job?.cancel()}>
          Cancel
        </Button>
      )}
    </div>
  );

  const exportCompare = () => {
    if (!result) return;
    const rows: (string | number)[][] = [['metric', ...KINDS.map((k) => `${KIND_LABEL[k]} mean`), ...KINDS.map((k) => `${KIND_LABEL[k]} ci95`)]];
    for (const k of METRIC_KEYS) rows.push([METRIC_LABELS[k].label, ...KINDS.map((x) => result.stats[x]![k].mean.toFixed(3)), ...KINDS.map((x) => result.stats[x]![k].ci.toFixed(3))]);
    rows.push([]);
    rows.push(['seed', ...KINDS.flatMap((k) => ['avg_delay_s', 'longest_red_s'].map((m) => `${k}_${m}`))]);
    for (let i = 0; i < result.seeds; i++) rows.push([i + 1, ...KINDS.flatMap((k) => [result.perController[k]![i].avgDelayVeh.toFixed(2), result.perController[k]![i].longestRed])]);
    downloadText(`signaltwin-scenario-${view}.csv`, toCsv(rows));
    toast('Scenario results downloaded.');
  };

  const noise20 = noise?.rows.find((r) => r.level === 20);
  const ablCols: Column<AblationRow>[] = useMemo(
    () => [
      { key: 'v', label: 'Variant', render: (r) => r.label },
      ...(['avgDelayVeh', 'p95Delay', 'longestRed', 'throughputVeh', 'jain'] as const).map<Column<AblationRow>>((k) => ({
        key: k,
        label: `${METRIC_LABELS[k].label}${METRIC_LABELS[k].unit ? `, ${METRIC_LABELS[k].unit}` : ''}`,
        num: true,
        render: (r) => {
          const own = fmtStat(k, r.stats[k]);
          if (!r.vsFull) return own;
          const d = r.vsFull[k];
          const sig = Math.abs(d.mean) > d.ci;
          return (
            <span>
              {own}
              <br />
              <span className={sig ? (isGood(k, d.mean) ? 'delta-good' : 'delta-bad') : 'muted'}>
                {d.pct > 0 ? '+' : ''}
                {d.pct.toFixed(1)} percent{sig ? '' : ', within noise'}
              </span>
            </span>
          );
        },
      })),
    ],
    [],
  );

  const noiseSeries: Series[] = noise
    ? [
        { id: 'w', label: 'Webster plan', data: noise.rows.map((r) => [r.level, r.stWebster.avgDelayVeh.mean] as [number, number]), tone: 'old', dash: '6 4', band: noise.rows.map((r) => [r.level, r.stWebster.avgDelayVeh.mean - r.stWebster.avgDelayVeh.ci, r.stWebster.avgDelayVeh.mean + r.stWebster.avgDelayVeh.ci] as [number, number, number]) },
        { id: 's', label: 'SignalTwin plan', data: noise.rows.map((r) => [r.level, r.stSignal.avgDelayVeh.mean] as [number, number]), tone: 'new', band: noise.rows.map((r) => [r.level, r.stSignal.avgDelayVeh.mean - r.stSignal.avgDelayVeh.ci, r.stSignal.avgDelayVeh.mean + r.stSignal.avgDelayVeh.ci] as [number, number, number]) },
      ]
    : [];

  return (
    <>
      <div className="page page-wide">
        <PageHeader
          title="Experiments"
          lede="The evidence. Every plan runs on the same random traffic, many times, with the spread reported. Nothing appears here that a completed run did not produce."
          actions={
            <div style={{ width: 130 }}>
              <NumberField label="Seeds per run" value={seeds} min={3} max={40} onChange={(n) => setSeeds(Math.round(n))} />
            </div>
          }
        />
        <Tabs
          label="Experiment type"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'scenarios', label: 'Scenarios' },
            { id: 'ablation', label: 'Ablation' },
            { id: 'noise', label: 'Noise' },
            { id: 'fairness', label: 'Fairness' },
          ]}
        />
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="stack" style={{ marginTop: 16 }}>
          <Swap id={tab}>
          <div className="stack">
          {tab === 'scenarios' && (
            <>
              <section className="panel stack" aria-labelledby="def-h">
                <h2 id="def-h">Scenario definitions</h2>
                <div className="home-pair" style={{ alignItems: 'start' }}>
                  <div className="stack-sm">
                    <h3>{scA.name}</h3>
                    <p className="muted">{scA.description}</p>
                    <SliderField label="Overall load" value={scA.targetY} min={0.3} max={0.95} step={0.05} format={(n) => `${Math.round(n * 100)}% of capacity`} onChange={(n) => setScA({ ...scA, targetY: n })} />
                  </div>
                  <div className="stack-sm">
                    <h3>{scB.name}</h3>
                    <p className="muted">North rises by the multiplier between the minutes below.</p>
                    <SliderField label="Overall load" value={scB.targetY} min={0.3} max={0.95} step={0.05} format={(n) => `${Math.round(n * 100)}% of capacity`} onChange={(n) => setScB({ ...scB, targetY: n })} />
                    <SliderField label="Surge multiplier" value={scB.surges[0].mult} min={1} max={4} step={0.2} format={(n) => `${n.toFixed(1)}x`} onChange={(n) => setScB({ ...scB, surges: [{ ...scB.surges[0], mult: n }] })} />
                    <SliderField label="Surge starts" value={Math.round(scB.surges[0].from / 60)} min={1} max={20} step={1} unit="min" onChange={(n) => setScB({ ...scB, surges: [{ ...scB.surges[0], from: n * 60, to: Math.max(n * 60 + 120, scB.surges[0].to) }] })} />
                    <SliderField label="Surge ends" value={Math.round(scB.surges[0].to / 60)} min={3} max={28} step={1} unit="min" onChange={(n) => setScB({ ...scB, surges: [{ ...scB.surges[0], to: Math.max(n * 60, scB.surges[0].from + 60) }] })} />
                  </div>
                </div>
                <div className="row">
                  <Button variant="primary" onClick={() => runScenarios(['A', 'B'])} loading={busy} disabled={busy}>
                    Run both scenarios
                  </Button>
                  <Button variant="secondary" onClick={() => runScenarios(['A'])} disabled={busy} disabledReason="A run is in progress.">
                    Run A only
                  </Button>
                  <Button variant="secondary" onClick={() => runScenarios(['B'])} disabled={busy} disabledReason="A run is in progress.">
                    Run B only
                  </Button>
                  {busy && (
                    <Button variant="secondary" onClick={() => job?.cancel()}>
                      Cancel
                    </Button>
                  )}
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setScA(SCENARIOS.A);
                      setScB(SCENARIOS.B);
                    }}
                  >
                    Reset definitions
                  </Button>
                </div>
                {progress}
              </section>
              <section className="panel stack" aria-labelledby="res-h">
                <div className="row-between">
                  <h2 id="res-h">Before and after</h2>
                  <div className="row">
                    <Tabs noPanels label="Scenario results" value={view} onChange={setView} tabs={[{ id: 'A', label: 'Scenario A' }, { id: 'B', label: 'Scenario B' }]} />
                    <Button variant="secondary" icon="download" onClick={exportCompare} disabled={!result} disabledReason="Run this scenario first.">
                      Export CSV
                    </Button>
                  </div>
                </div>
                {!result ? (
                  <EmptyState title={`No result for Scenario ${view} yet`} body={`Run Scenario ${view} to fill this table. It runs ${seeds} seeds for the observed, Webster, VAC and SignalTwin plans.`} />
                ) : (
                  <>
                    <ResultTable result={result} />
                    <StripPlot title="Average delay in each seed" groups={KINDS.map((k) => ({ label: KIND_LABEL[k], values: result.perController[k]!.map((m) => m.avgDelayVeh), tone: k === 'signaltwin' ? 'new' : k === 'webster' ? 'old' : 'ink' }))} unit="Seconds per vehicle" />
                  </>
                )}
              </section>
            </>
          )}

          {tab === 'ablation' && (
            <section className="panel stack" aria-labelledby="abl-h">
              <h2 id="abl-h">Ablation, Scenario B</h2>
              <p className="muted">Each feature is removed on its own to show what it contributes. The change shown under each value is against the full SignalTwin plan, paired by seed.</p>
              {runBar(runAblation, 'Run ablation')}
              {progress}
              {!abl ? (
                <EmptyState title="No ablation yet" body="Run the ablation to compare the full plan with versions that lack the fairness guard, look-ahead, PCU weighting or hysteresis." />
              ) : (
                <>
                  <DataTable rows={abl.rows} columns={ablCols} rowKey={(r) => r.id} ariaLabel="Ablation results" />
                  <div className="row">
                    <span className="muted">Your run, {abl.seeds} seeds.</span>
                    <Button
                      variant="secondary"
                      icon="download"
                      onClick={() => {
                        const rows: (string | number)[][] = [['variant', ...METRIC_KEYS.map((k) => METRIC_LABELS[k].label)]];
                        for (const r of abl.rows) rows.push([r.label, ...METRIC_KEYS.map((k) => r.stats[k].mean.toFixed(3))]);
                        downloadText('signaltwin-ablation.csv', toCsv(rows));
                        toast('Ablation downloaded.');
                      }}
                    >
                      Export CSV
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}

          {tab === 'noise' && (
            <section className="panel stack" aria-labelledby="noi-h">
              <h2 id="noi-h">Noise robustness, Scenario A</h2>
              <p className="muted">The controller is shown a corrupted view of the road: some vehicles missed, some class labels wrong, counts delayed. The Webster plan does not read detections, so its line is flat apart from seed variation.</p>
              {runBar(runNoise, 'Run noise test')}
              {progress}
              {!noise ? (
                <EmptyState title="No noise test yet" body="Run the test at 0, 10, 20 and 30 percent missed detections." />
              ) : (
                <>
                  <LineChart title="Average delay against detection noise" series={noiseSeries} height={260} xLabel="Missed detections (%)" yLabel="Seconds per vehicle" xFormat={(n) => `${Math.round(n)}`} yFormat={(n) => n.toFixed(0)} unit="s" xDomain={[0, 30]} />
                  {noise20 && (
                    <p className="reason tnum" aria-live="polite">
                      <strong>At 20 percent missed detections</strong> SignalTwin averages {noise20.stSignal.avgDelayVeh.mean.toFixed(1)} s against {noise20.stWebster.avgDelayVeh.mean.toFixed(1)} s for the Webster plan.{' '}
                      {noise20.stSignal.avgDelayVeh.mean < noise20.stWebster.avgDelayVeh.mean ? 'SignalTwin still beats the baseline at this noise level.' : 'SignalTwin no longer beats the baseline at this noise level.'}
                    </p>
                  )}
                  <Button
                    variant="secondary"
                    icon="download"
                    onClick={() => {
                      downloadText('signaltwin-noise.csv', toCsv([['noise_percent', 'signaltwin_delay_mean', 'signaltwin_ci95', 'webster_delay_mean', 'webster_ci95'], ...noise.rows.map((r) => [r.level, r.stSignal.avgDelayVeh.mean.toFixed(2), r.stSignal.avgDelayVeh.ci.toFixed(2), r.stWebster.avgDelayVeh.mean.toFixed(2), r.stWebster.avgDelayVeh.ci.toFixed(2)])]));
                      toast('Noise results downloaded.');
                    }}
                  >
                    Export CSV
                  </Button>
                </>
              )}
            </section>
          )}

          {tab === 'fairness' && (
            <section className="panel stack" aria-labelledby="fa-h">
              <div className="row-between">
                <h2 id="fa-h">Fairness, Scenario {view}</h2>
                <Tabs noPanels label="Scenario" value={view} onChange={setView} tabs={[{ id: 'A', label: 'Scenario A' }, { id: 'B', label: 'Scenario B' }]} />
              </div>
              {!result ? (
                <EmptyState title={`No Scenario ${view} run yet`} body="The fairness charts use the seeds from a scenario run." action={<Button variant="primary" onClick={() => runScenarios([view])} loading={busy} disabled={busy}>Run Scenario {view}</Button>} />
              ) : (
                <>
                  <div className="home-pair" style={{ alignItems: 'start' }}>
                    <StripPlot title="Longest red time in each seed" groups={KINDS.map((k) => ({ label: KIND_LABEL[k], values: result.perController[k]!.map((m) => m.longestRed), tone: k === 'signaltwin' ? 'new' : k === 'webster' ? 'old' : 'ink' }))} unit="Seconds" refLine={{ y: params.fairnessCap, label: `Cap ${params.fairnessCap} s` }} />
                    <StripPlot title="Longest wait of any vehicle in each seed" groups={KINDS.map((k) => ({ label: KIND_LABEL[k], values: result.perController[k]!.map((m) => m.longestWait), tone: k === 'signaltwin' ? 'new' : k === 'webster' ? 'old' : 'ink' }))} unit="Seconds" />
                  </div>
                  <div className="table-wrap">
                    <table className="table" aria-label="Fairness summary">
                      <thead>
                        <tr>
                          <th>Plan</th>
                          <th className="num">Jain's index</th>
                          <th className="num">Longest red</th>
                          <th className="num">Longest vehicle wait</th>
                        </tr>
                      </thead>
                      <tbody>
                        {KINDS.map((k) => (
                          <tr key={k}>
                            <td>{KIND_LABEL[k]}</td>
                            <td className="num">{fmtStat('jain', result.stats[k]!.jain)}</td>
                            <td className="num">{fmtStat('longestRed', result.stats[k]!.longestRed)} s</td>
                            <td className="num">{fmtStat('longestWait', result.stats[k]!.longestWait)} s</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted">The cap limits time without a green signal. In heavy oversaturation a single vehicle can still wait through more than one green, so the longest vehicle wait is reported on its own.</p>
                </>
              )}
            </section>
          )}

          </div>
          </Swap>

          <section className="panel stack" aria-labelledby="hist-h">
            <div className="row-between">
              <h2 id="hist-h">Run history</h2>
              <Button
                variant="quiet"
                onClick={() => {
                  clearRuns();
                  toast('Run history cleared.');
                }}
                disabled={!runs.length}
                disabledReason="There are no saved runs."
              >
                Clear history
              </Button>
            </div>
            {runs.length === 0 ? (
              <p className="muted">No completed runs yet. Runs are saved here so you can restore them after a reload.</p>
            ) : (
              <ul className="status-list" aria-label="Saved runs">
                {runs.map((r) => (
                  <li key={r.id}>
                    <span>
                      <strong>{r.label}</strong>, {r.seeds} seeds, {new Date(r.at).toLocaleTimeString()}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (r.kind === 'compare') {
                          setCmp((c) => ({ ...c, [r.scenarioId as 'A' | 'B']: r.data as ComparisonResult }));
                          setView(r.scenarioId as 'A' | 'B');
                          setTab('scenarios');
                        } else if (r.kind === 'ablation') {
                          setAbl({ rows: (r.data as { rows: AblationRow[] }).rows, seeds: r.seeds });
                          setTab('ablation');
                        } else if (r.kind === 'noise') {
                          setNoise({ rows: (r.data as { rows: NoiseRow[] }).rows, seeds: r.seeds });
                          setTab('noise');
                        }
                        setRestored(r.id);
                        toast(`Restored ${r.label}.`);
                      }}
                      disabled={r.kind === 'grid'}
                      disabledReason="Grid searches are shown on the Controller page."
                    >
                      {restored === r.id ? 'Restored' : 'Restore'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted">
              Finished a run? <Link to="/report">Build the report</Link>.
            </p>
          </section>
        </div>
      </div>
      <Footer />
    </>
  );
}


