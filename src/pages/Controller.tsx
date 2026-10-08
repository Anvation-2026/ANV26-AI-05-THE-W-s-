import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APPROACH_NAMES, APPROACHES, type RuleKind } from '../contracts';
import { SCENARIOS, DEFAULT_PARAMS, phaseName } from '../engine/params';
import { makeSim, profileFor } from '../engine/experiment';
import { JunctionView, type HighlightRef } from '../components/JunctionView';
import { Transport } from '../components/widgets';
import { Legend, ScoreBar } from '../components/charts';
import { Button, DataTable, Meter, NumberField, PageHeader, Segmented, SliderField, Toggle, toast, type Column } from '../components/ui';
import { useApp } from '../store/app';
import { useSetup } from '../hooks/useSetup';
import { useRunner } from '../hooks/useRunner';
import { useCommands, Footer } from '../shell/Layout';
import { useRunStatus } from '../shell/status';
import { startExperiment, type Job } from '../engine/workerClient';
import type { GridRow } from '../engine/experiment';
import { downloadText, mmss, toCsv } from '../lib/util';
import type { DecisionEntry } from '../contracts';
import type { Sim } from '../engine/sim';

const RULE_LABEL: Record<RuleKind, string> = {
  stay: 'Stay',
  switch: 'Switch',
  mingreen: 'Stay, minimum green',
  maxgreen: 'Forced by max green',
  fairness: 'Forced by fairness guard',
  emergency: 'Emergency',
  clearance: 'Clearing the standing queue',
  extend: 'Extending green',
  gapout: 'Gap-out',
  fixed: 'Fixed plan',
};

export default function Controller() {
  const params = useApp((s) => s.params);
  const options = useApp((s) => s.options);
  const setParams = useApp((s) => s.setParams);
  const setOptions = useApp((s) => s.setOptions);
  const setObjective = useApp((s) => s.setObjective);
  const scenarioId = useApp((s) => s.scenarioId);
  const seed = useApp((s) => s.seed);
  const setStatus = useRunStatus((s) => s.set);
  const setup = useSetup(SCENARIOS[scenarioId]);
  const profile = useMemo(() => profileFor(setup), [setup]);
  const highlight = useRef<HighlightRef['current']>(null) as HighlightRef;
  const [plan, setPlan] = useState<'signaltwin' | 'vac'>('signaltwin');

  const factory = useCallback(
    (em: { t: number; approach: number }[]) => [makeSim({ ...setup, emergencies: em }, plan, seed, profile)],
    [setup, profile, seed, plan],
  );
  const runner = useRunner(factory, params.horizon, [factory]);
  const sim = runner.sims[0];
  useEffect(() => {
    runner.seek(200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useCommands({ toggle: () => runner.toggle(), restart: () => runner.reset(), speed: (d) => runner.setSpeed(Math.max(1, Math.min(8, d > 0 ? runner.speed * 2 : runner.speed / 2))), emergency: () => runner.triggerEmergency(2) });
  useEffect(() => {
    setStatus(runner.playing ? 'Playing' : `Paused at ${mmss(runner.t)}`);
    return () => setStatus('Idle');
  }, [runner.playing, runner.t, setStatus]);

  const ev = sim?.controller.lastEval;
  const clearance = params.yellow + params.allRed;
  const bound = params.maxGreen + params.yellow + 2 * params.allRed;
  const twoPhase = (sim?.phases.length ?? 2) === 2;
  const guarantee = options.fairnessGuard ? (twoPhase ? Math.min(params.fairnessCap, bound) : params.fairnessCap) : bound;
  const maxScore = ev ? Math.max(10, ...ev.phases.map((p) => p.score), ev.needed) * 1.1 : 10;

  const [filter, setFilter] = useState<'all' | RuleKind>('all');
  const [query, setQuery] = useState('');
  const decisions: DecisionEntry[] = sim?.decisions ?? [];
  const shown = useMemo(
    () => decisions.filter((d) => (filter === 'all' || d.rule === filter) && (!query.trim() || `${d.action} ${d.reason}`.toLowerCase().includes(query.toLowerCase()))).slice().reverse(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runner.version, filter, query],
  );
  const cols: Column<DecisionEntry>[] = [
    { key: 't', label: 'Time', render: (d) => <span className="tnum">{mmss(d.t)}</span>, sort: (d) => d.t },
    { key: 'a', label: 'Action', render: (d) => d.action, sort: (d) => d.action },
    { key: 'r', label: 'Rule', render: (d) => RULE_LABEL[d.rule], sort: (d) => d.rule },
    { key: 'why', label: 'Reason', render: (d) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{d.reason}</span> },
  ];

  const [job, setJob] = useState<Job | null>(null);
  const [prog, setProg] = useState<number>(0);
  const [grid, setGrid] = useState<{ rows: GridRow[]; best: GridRow | null } | null>(null);
  useEffect(() => () => job?.cancel(), [job]);
  const runGrid = async () => {
    const j = startExperiment({ type: 'grid', setup, seeds: 5, betas: [0.5, 1, 1.5, 2], gammas: [0, 0.25, 0.5, 1, 2] }, (p) => setProg(p.done / p.total));
    setJob(j);
    setProg(0);
    try {
      const r = await j.promise;
      if (r.type === 'grid') {
        setGrid({ rows: r.rows, best: r.best });
        toast(r.best ? `Best weights: beta ${r.best.beta}, gamma ${r.best.gamma}.` : 'The search finished.');
      }
    } catch (e) {
      if ((e as Error).message === 'cancelled') toast('Grid search cancelled.');
      else toast(`The grid search failed: ${(e as Error).message}`, 'error');
    } finally {
      setJob(null);
    }
  };

  const gridCols: Column<GridRow>[] = [
    { key: 'b', label: 'Beta', num: true, render: (r) => r.beta, sort: (r) => r.beta },
    { key: 'g', label: 'Gamma', num: true, render: (r) => r.gamma, sort: (r) => r.gamma },
    { key: 'd', label: 'Average delay, s', num: true, render: (r) => r.avgDelay.toFixed(1), sort: (r) => r.avgDelay },
    { key: 'red', label: 'Longest red, s', num: true, render: (r) => r.longestRed.toFixed(0), sort: (r) => r.longestRed },
    { key: 'ok', label: 'Cap kept', render: (r) => (r.ok ? 'Yes' : 'No'), sort: (r) => (r.ok ? 0 : 1) },
  ];

  return (
    <>
      <div className="page page-wide">
        <PageHeader title="Controller" lede="Every decision explained. Scrub the timeline to any second to see how each phase scored, which rule fired and how close any road is to the fairness cap." />
        <div className="console-grid" style={{ ['--gcols' as string]: 'minmax(260px, 3fr) minmax(300px, 3.4fr) 0px minmax(300px, 3.2fr)' }}>
          <section className="stack-sm" aria-label="Junction and timeline">
            <div className="panel row">
              <span className="field-label">Plan shown</span>
              <Segmented label="Plan shown" value={plan} options={[{ value: 'signaltwin', label: 'SignalTwin' }, { value: 'vac', label: 'VAC' }]} onChange={setPlan} />
            </div>
            <div className="panel-asphalt on-asphalt" style={{ padding: 8 }}>
              <JunctionView runner={runner} simIndex={0} overlays={{ queueZones: true, labels: true }} highlight={highlight} caption={`${plan === 'vac' ? 'VAC plan' : 'SignalTwin plan'}, ${SCENARIOS[scenarioId].name}, seed ${seed}`} />
            </div>
            <div className="panel">
              <Transport runner={runner} />
            </div>
          </section>

          <section className="panel stack" aria-labelledby="sc-h">
            <h2 id="sc-h">{plan === 'vac' ? 'How VAC decides' : 'Score breakdown'} at {mmss(runner.t)}</h2>
            {ev ? (
              <>
                <p className="reason" aria-live="polite">
                  <strong>{RULE_LABEL[ev.rule]}.</strong> {ev.reason || 'Press play or move the timeline.'}
                </p>
                <div className="table-wrap">
                  <table className="table" aria-label="Score per phase">
                    <thead>
                      <tr>
                        <th>Phase</th>
                        <th className="num">Queue</th>
                        <th className="num">Beta times arrivals</th>
                        <th className="num">Gamma times aging</th>
                        <th className="num">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ev.phases.map((p, i) => (
                        <tr key={i} className={i === ev.current ? 'is-selected' : ''}>
                          <td>
                            {phaseName(sim.phases[i])}
                            {i === ev.current ? ', current' : ''}
                          </td>
                          <td className="num">{p.q.toFixed(1)}</td>
                          <td className="num">{p.e.toFixed(1)}</td>
                          <td className="num">{p.a.toFixed(1)}</td>
                          <td className="num">
                            <strong>{p.score.toFixed(1)}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="stack-sm">
                  {ev.phases.map((p, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '54px 1fr', gap: 10, alignItems: 'center' }}>
                      <strong>{phaseName(sim.phases[i])}</strong>
                      <ScoreBar q={p.q} e={p.e} a={p.a} max={maxScore} label={`Phase ${phaseName(sim.phases[i])}`} />
                    </div>
                  ))}
                  <Legend items={[{ label: `Queue (${options.objective === 'people' ? 'people' : 'PCU'})`, pattern: 0 }, { label: 'Arriving soon', pattern: 1 }, { label: 'Waiting too long', pattern: 2 }]} />
                </div>
                <ul className="status-list tnum">
                  <li>
                    <span>Current phase score</span>
                    <span>{ev.phases[ev.current].score.toFixed(1)}</span>
                  </li>
                  <li>
                    <span>Score the best other phase must beat ({options.hysteresisOn ? Math.round(params.hysteresis * 100) : 0} percent margin)</span>
                    <span>{ev.needed.toFixed(1)}</span>
                  </li>
                  <li>
                    <span>Best other phase</span>
                    <span>
                      {phaseName(sim.phases[ev.best])}, {ev.phases[ev.best].score.toFixed(1)}
                    </span>
                  </li>
                </ul>
              </>
            ) : (
              <VacPanel sim={sim} plan={plan} />
            )}
          </section>

          <div />

          <section className="panel stack" aria-labelledby="fair-h">
            <h2 id="fair-h">Fairness against the cap</h2>
            <div className="stack-sm">
              {APPROACHES.map((a, ap) => {
                const red = sim?.red[ap] ?? 0;
                const left = Math.max(0, params.fairnessCap - clearance - 2 - red);
                return (
                  <div key={a} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 120px', gap: 8, alignItems: 'center' }}>
                    <span>{APPROACH_NAMES[a]}</span>
                    <Meter value={red} max={params.fairnessCap * 1.1} cap={params.fairnessCap} label={`${APPROACH_NAMES[a]} red time against the cap`} />
                    <span className="tnum" style={{ textAlign: 'right' }}>
                      {red} s{red > 0 && options.fairnessGuard ? `, forced in ${left} s` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="reason">
              <strong>Guarantee for these settings.</strong> Worst case without green: {guarantee} s, cap {params.fairnessCap} s. That is the other phase's {params.maxGreen} s maximum green plus {params.yellow} s yellow plus two {params.allRed} s all-red periods ({bound} s), held under the cap by the guard.
            </p>
            <p className="muted">This caps time without a green signal. In heavy oversaturation one vehicle can still wait through more than one green, so the Experiments page reports the longest vehicle wait too.</p>
          </section>
        </div>

        <section className="panel stack" style={{ marginTop: 'var(--s-3)' }} aria-labelledby="set-h">
          <div className="row-between">
            <h2 id="set-h">Controller settings</h2>
            <div className="row">
              <Button
                variant="secondary"
                onClick={() => {
                  setParams({ beta: DEFAULT_PARAMS.beta, gamma: DEFAULT_PARAMS.gamma, lookaheadH: DEFAULT_PARAMS.lookaheadH, vacGap: DEFAULT_PARAMS.vacGap, hysteresis: DEFAULT_PARAMS.hysteresis, minGreen: DEFAULT_PARAMS.minGreen, maxGreen: DEFAULT_PARAMS.maxGreen, fairnessCap: DEFAULT_PARAMS.fairnessCap });
                  toast('Controller settings reset to the tuned defaults.');
                }}
              >
                Reset to tuned defaults
              </Button>
              <Button variant="primary" onClick={runGrid} loading={!!job} disabled={!!job}>
                Run grid search
              </Button>
              {job && (
                <Button variant="secondary" onClick={() => job.cancel()}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
          <div className="controls" style={{ padding: 0, background: 'transparent' }}>
            <SliderField label="Beta, weight of arrivals" value={params.beta} min={0} max={4} step={0.1} format={(n) => n.toFixed(1)} onChange={(n) => setParams({ beta: n })} />
            <SliderField label="Gamma, weight of aging" value={params.gamma} min={0} max={4} step={0.1} format={(n) => n.toFixed(1)} onChange={(n) => setParams({ gamma: n })} />
            <SliderField label="Look-ahead horizon" value={params.lookaheadH} min={4} max={16} step={1} unit="s" onChange={(n) => setParams({ lookaheadH: n })} />
            <SliderField label="Hysteresis margin" value={Math.round(params.hysteresis * 100)} min={0} max={150} step={5} unit="%" onChange={(n) => setParams({ hysteresis: n / 100 })} />
            <div style={{ width: 150 }}>
              <NumberField label="VAC passage time" value={params.vacGap} min={1} max={8} unit="s" onChange={(n) => setParams({ vacGap: n })} />
            </div>
            <div style={{ width: 130 }}>
              <NumberField label="Minimum green" value={params.minGreen} min={5} max={params.maxGreen} unit="s" onChange={(n) => setParams({ minGreen: n })} />
            </div>
            <div style={{ width: 130 }}>
              <NumberField label="Maximum green" value={params.maxGreen} min={params.minGreen} max={180} unit="s" onChange={(n) => setParams({ maxGreen: n })} />
            </div>
            <div style={{ width: 150 }}>
              <NumberField label="Fairness cap" value={params.fairnessCap} min={30} max={240} unit="s" onChange={(n) => setParams({ fairnessCap: n })} />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <span className="field-label">Objective</span>
              <Segmented label="Objective" value={options.objective} options={[{ value: 'vehicles', label: 'Vehicles' }, { value: 'people', label: 'People' }]} onChange={setObjective} />
            </div>
            <Toggle label="Platoon look-ahead" checked={options.lookahead} onChange={(v) => setOptions({ lookahead: v })} />
            <Toggle label="Emergency priority" checked={options.emergencyPriority} onChange={(v) => setOptions({ emergencyPriority: v })} />
            <Toggle label="Fairness guard" checked={options.fairnessGuard} onChange={(v) => setOptions({ fairnessGuard: v })} />
            <Toggle label="Clear standing queue first" checked={options.queueClearance} onChange={(v) => setOptions({ queueClearance: v })} hint="Hold green until the vehicles that were in the queue zone when it started have left." />
          </div>
          {job && <Meter value={prog} max={1} label="Grid search progress" />}
          {grid && (
            <div className="stack-sm">
              <h3>Grid search result, five seeds, Scenario {scenarioId}</h3>
              <DataTable rows={grid.rows} columns={gridCols} rowKey={(r) => `${r.beta}-${r.gamma}`} ariaLabel="Grid search results" maxHeight={260} selectedKey={grid.best ? `${grid.best.beta}-${grid.best.gamma}` : null} />
              {grid.best && (
                <div className="row">
                  <span className="tnum">
                    Best: beta {grid.best.beta}, gamma {grid.best.gamma}, delay {grid.best.avgDelay.toFixed(1)} s.
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setParams({ beta: grid.best!.beta, gamma: grid.best!.gamma });
                      toast(`Applied beta ${grid.best!.beta} and gamma ${grid.best!.gamma}.`);
                    }}
                  >
                    Apply the best weights
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="panel stack" style={{ marginTop: 'var(--s-3)' }} aria-labelledby="log-h">
          <div className="row-between">
            <h2 id="log-h">Decision log</h2>
            <Button
              variant="secondary"
              icon="download"
              onClick={() => {
                downloadText(
                  `signaltwin-decisions-seed${seed}.csv`,
                  toCsv([['time_s', 'action', 'rule', 'reason'], ...decisions.map((d) => [d.t, d.action, RULE_LABEL[d.rule], d.reason])]),
                );
                toast('Decision log downloaded.');
              }}
              disabled={!decisions.length}
              disabledReason="No decisions yet. Press play first."
            >
              Export CSV
            </Button>
          </div>
          <div className="controls" style={{ padding: 0, background: 'transparent' }}>
            <div className="field">
              <label className="field-label" htmlFor="log-filter">
                Rule
              </label>
              <select id="log-filter" className="select" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | RuleKind)}>
                <option value="all">All rules</option>
                {(Object.keys(RULE_LABEL) as RuleKind[]).map((r) => (
                  <option key={r} value={r}>
                    {RULE_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ minWidth: 240 }}>
              <label className="field-label" htmlFor="log-q">
                Search the reasons
              </label>
              <input id="log-q" className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="For example East or cap" />
            </div>
            <span className="muted tnum">
              {shown.length} of {decisions.length}
            </span>
          </div>
          <DataTable
            rows={shown}
            columns={cols}
            rowKey={(d) => `${d.t}-${d.action}-${d.rule}`}
            ariaLabel="Decision log"
            maxHeight={360}
            onRowHover={(d) => d && (highlight.current = { ap: d.approaches[0] ?? 0, at: performance.now() })}
            empty={<p className="muted">No decisions match. Clear the filter or press play to generate more.</p>}
          />
        </section>
      </div>
      <Footer />
    </>
  );
}

/** Explains what the vehicle-actuated plan is doing right now. It does not score phases. */
function VacPanel({ sim, plan }: { sim: Sim | undefined; plan: 'signaltwin' | 'vac' }) {
  if (!sim) return <p className="muted">Press play to start the run.</p>;
  if (plan !== 'vac') return <p className="muted">Press play to start the run.</p>;
  const v = sim.buildView();
  const names = ['North', 'South', 'East', 'West'];
  return (
    <div className="stack">
      <p className="reason" aria-live="polite">
        <strong>{RULE_LABEL[sim.controller.lastRule]}.</strong> {sim.controller.lastReason || 'Press play or move the timeline.'}
      </p>
      <p className="muted">VAC does not score phases. It reads detectors: it holds green while the vehicles that were standing in the queue zone leave, extends while vehicles keep arriving and nobody else waits, and gaps out when the road empties.</p>
      <div className="table-wrap">
        <table className="table" aria-label="What the detectors see">
          <thead>
            <tr>
              <th>Approach</th>
              <th className="num">Vehicles queued</th>
              <th className="num">Arriving within the passage time</th>
              <th className="num">Queue, PCU</th>
            </tr>
          </thead>
          <tbody>
            {names.map((n, ap) => (
              <tr key={n}>
                <td>{n}</td>
                <td className="num">{v.qCount[ap]}</td>
                <td className="num">{v.arrSoon[ap]}</td>
                <td className="num">{v.q[ap].toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="status-list tnum">
        <li>
          <span>Standing queue when this green began</span>
          <span>{v.standingStart} vehicles</span>
        </li>
        <li>
          <span>Still waiting from that queue</span>
          <span>{v.standingLeft} vehicles</span>
        </li>
      </ul>
    </div>
  );
}