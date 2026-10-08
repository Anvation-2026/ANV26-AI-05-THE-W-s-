import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { APPROACH_NAMES, APPROACHES, METRIC_KEYS, VEHICLE_CLASSES, type ComparisonResult, type DemandEstimate } from '../contracts';
import { useApp } from '../store/app';
import { api } from '../api';
import { SCENARIOS, phaseName } from '../engine/params';
import { makeSim, profileFor } from '../engine/experiment';
import { websterPlan } from '../engine/demand';
import { METRIC_LABELS } from '../engine/metrics';
import { useSetup } from '../hooks/useSetup';
import { LineChart, StripPlot, type Series } from '../components/charts';
import { Button, Check, EmptyState, PageHeader, SkeletonBlock, Tabs, toast } from '../components/ui';
import { ResultTable } from './Console';
import { copyText, downloadBlob, downloadText, fmtStat, mmss, toCsv } from '../lib/util';
import { Footer } from '../shell/Layout';

const SECTIONS = [
  { id: 'demand', label: 'Demand summary' },
  { id: 'plan', label: 'Recommended signal plan' },
  { id: 'compare', label: 'Before and after table' },
  { id: 'charts', label: 'Charts' },
  { id: 'log', label: 'Decision log excerpt' },
  { id: 'assume', label: 'Assumptions and limitations' },
] as const;
type SecId = (typeof SECTIONS)[number]['id'];

export default function Report() {
  const params = useApp((s) => s.params);
  const junction = useApp((s) => s.junction);
  const usingSample = useApp((s) => s.usingSample);
  const runs = useApp((s) => s.runs);
  const countsRows = useApp((s) => s.countsRows);
  const calibrated = useApp((s) => s.calibrated);
  const [view, setView] = useState<'A' | 'B'>('A');
  const [on, setOn] = useState<Record<SecId, boolean>>({ demand: true, plan: true, compare: true, charts: true, log: true, assume: true });
  const [est, setEst] = useState<DemandEstimate | null>(null);

  const compare = (id: 'A' | 'B') => runs.find((r) => r.kind === 'compare' && r.scenarioId === id)?.data as ComparisonResult | undefined;
  const result = compare(view);
  const setup = useSetup(SCENARIOS[view]);
  const profile = useMemo(() => profileFor(setup), [setup]);

  useEffect(() => {
    let live = true;
    api
      .estimateDemand(junction.source === 'counts' && countsRows.length ? { kind: 'counts', rows: countsRows } : { kind: 'sample' }, junction, params)
      .then((e) => live && setEst(e))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [junction, countsRows, params]);

  const sims = useMemo(() => {
    const old = makeSim(setup, 'observed', 1, profile).run();
    const web = makeSim(setup, 'webster', 1, profile).run();
    const nw = makeSim(setup, 'signaltwin', 1, profile).run();
    return { old, web, nw };
  }, [setup, profile]);
  const plan = useMemo(() => websterPlan(profile, params), [profile, params]);
  const phases = sims.nw.phases;
  const greenStats = useMemo(() => {
    const per: number[][] = phases.map(() => []);
    const sw = sims.nw.decisions.filter((d) => d.from !== d.to);
    for (const g of sims.nw.greenStarts) {
      const next = sw.find((d) => d.t >= g.t && d.from === g.phase);
      if (next) per[g.phase].push(next.t - g.t);
    }
    return per.map((v) => ({ n: v.length, min: Math.min(...v), mean: v.reduce((a, b) => a + b, 0) / Math.max(1, v.length), max: Math.max(...v) }));
  }, [sims, phases]);

  const queue = (sim: typeof sims.nw): [number, number][] => {
    const out: [number, number][] = [];
    for (let t = 0; t < sim.t; t += 5) out.push([t, sim.qSeries.reduce((s, q) => s + q[t], 0)]);
    return out;
  };
  const series: Series[] = [
    { id: 'o', label: 'Current plan', data: queue(sims.old), tone: 'old', dash: '6 4' },
    { id: 'n', label: 'SignalTwin plan', data: queue(sims.nw), tone: 'new' },
  ];

  const summaryText = () => {
    const lines: string[] = [];
    lines.push(`SignalTwin report for ${junction.name} (${usingSample ? 'sample junction' : 'your data'}).`);
    lines.push(`Scenario: ${SCENARIOS[view].name}.`);
    if (result) {
      lines.push(`Comparison of ${result.seeds} seeds, same traffic for every plan, mean with 95 percent interval:`);
      for (const k of ['avgDelayVeh', 'p95Delay', 'longestRed', 'throughputVeh', 'jain'] as const) {
        lines.push(`- ${METRIC_LABELS[k].label}: observed ${fmtStat(k, result.stats.observed![k])}, Webster ${fmtStat(k, result.stats.webster![k])}, SignalTwin ${fmtStat(k, result.stats.signaltwin![k])}.`);
      }
    } else lines.push('No comparison has been run for this scenario yet.');
    lines.push(`Webster fixed plan: cycle ${plan.cycle} s, greens ${plan.greens.join(' s and ')} s.`);
    lines.push('SignalTwin recommends a plan. It does not operate any signal. Values are simulation outputs and depend on the inputs and assumptions listed in the report.');
    return lines.join('\n');
  };

  const downloadCsvFile = () => {
    const rows: (string | number)[][] = [['SignalTwin report'], ['junction', junction.name], ['scenario', SCENARIOS[view].name], []];
    if (on.demand && est) {
      rows.push(['Demand summary'], ['approach', 'vehicles', 'mean_pcu_per_s']);
      APPROACHES.forEach((a, ap) => rows.push([APPROACH_NAMES[a], est.totals[ap], (est.smoothPcu[ap].reduce((s, v) => s + v, 0) / Math.max(1, est.smoothPcu[ap].length)).toFixed(3)]));
      rows.push([]);
    }
    if (on.plan) {
      rows.push(['Recommended plan'], ['Webster cycle_s', plan.cycle], ...phases.map((p, i) => [`Webster green ${phaseName(p)}_s`, plan.greens[i]] as (string | number)[]), ...phases.map((p, i) => [`SignalTwin green ${phaseName(p)} mean_s`, greenStats[i].mean.toFixed(1)] as (string | number)[]), []);
    }
    if (on.compare && result) {
      rows.push(['Before and after', 'observed_mean', 'observed_ci95', 'webster_mean', 'webster_ci95', 'signaltwin_mean', 'signaltwin_ci95']);
      for (const k of METRIC_KEYS) rows.push([METRIC_LABELS[k].label, ...(['observed', 'webster', 'signaltwin'] as const).flatMap((c) => [result.stats[c]![k].mean.toFixed(3), result.stats[c]![k].ci.toFixed(3)])]);
      rows.push([]);
    }
    if (on.log) {
      rows.push(['Decision log', 'time_s', 'action', 'reason']);
      sims.nw.decisions.slice(0, 20).forEach((d) => rows.push(['', d.t, d.action, d.reason]));
    }
    downloadText(`signaltwin-report-scenario-${view}.csv`, toCsv(rows));
    toast('Report data downloaded as CSV.');
  };

  const downloadAll = () => {
    const data = { exportedAt: new Date().toISOString(), junction, params, calibrated, runs, note: 'All numbers come from runs made in this app.' };
    downloadBlob('signaltwin-all-data.json', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    toast('All data downloaded as JSON.');
  };

  const noRuns = runs.filter((r) => r.kind === 'compare').length === 0;

  return (
    <>
      <div className="page page-wide">
        <PageHeader title="Report" lede="The deliverable. Pick the sections, check the preview, then download or print it." />
        <div className="report-grid">
          <aside className="panel stack no-print" aria-label="Report options">
            <h2>Sections</h2>
            <div className="stack-sm">
              {SECTIONS.map((s) => (
                <Check key={s.id} label={s.label} checked={on[s.id]} onChange={(v) => setOn({ ...on, [s.id]: v })} />
              ))}
            </div>
            <div className="field">
              <span className="field-label">Scenario</span>
              <Tabs noPanels label="Report scenario" value={view} onChange={setView} tabs={[{ id: 'A', label: 'A balanced' }, { id: 'B', label: 'B surge' }]} />
            </div>
            <div className="stack-sm">
              <Button variant="primary" icon="download" onClick={downloadCsvFile}>
                Download CSV
              </Button>
              <Button
                variant="secondary"
                icon="report"
                onClick={() => {
                  toast('Choose Save as PDF in the print window.');
                  window.setTimeout(() => window.print(), 200);
                }}
              >
                Download PDF
              </Button>
              <Button
                variant="secondary"
                icon="copy"
                onClick={async () => {
                  const ok = await copyText(summaryText());
                  toast(ok ? 'Summary copied.' : 'Copy failed. Allow clipboard access and try again.', ok ? 'info' : 'error');
                }}
              >
                Copy summary as text
              </Button>
              <Button variant="secondary" icon="download" onClick={downloadAll}>
                Download all raw data
              </Button>
            </div>
          </aside>

          <article className="report-sheet" aria-label="Report preview">
            <header className="stack-sm">
              <h2 style={{ fontSize: 'var(--fs-28)' }}>Signal plan recommendation, {junction.name}</h2>
              <p className="muted">{usingSample ? 'Sample junction. Every number below comes from the built-in sample data.' : `Built from ${junction.source === 'counts' ? 'your counts file' : 'your video'}.`} {SCENARIOS[view].name}. Generated {new Date().toLocaleDateString()}.</p>
              <p>SignalTwin recommends a plan. It does not operate any signal.</p>
            </header>
            {noRuns && (
              <EmptyState
                title="No comparison has been run yet"
                body="The before and after table needs a completed run. Run the twenty-seed comparison in the Console or in Experiments, then come back."
                action={
                  <Link className="btn btn-primary" to="/console">
                    Go to the Console
                  </Link>
                }
              />
            )}

            {on.demand && (
              <section className="stack-sm" aria-labelledby="r-demand">
                <h3 id="r-demand">Demand summary</h3>
                {!est ? (
                  <SkeletonBlock lines={4} />
                ) : (
                  <div className="table-wrap">
                    <table className="table" aria-label="Demand summary">
                      <thead>
                        <tr>
                          <th>Approach</th>
                          <th className="num">Vehicles in the data</th>
                          <th className="num">Mean demand, PCU per s</th>
                          {VEHICLE_CLASSES.map((c) => (
                            <th key={c} className="num">
                              {params.classes[c].label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {APPROACHES.map((a, ap) => (
                          <tr key={a}>
                            <td>{APPROACH_NAMES[a]}</td>
                            <td className="num">{est.totals[ap]}</td>
                            <td className="num">{(est.smoothPcu[ap].reduce((s, v) => s + v, 0) / Math.max(1, est.smoothPcu[ap].length)).toFixed(3)}</td>
                            {VEHICLE_CLASSES.map((c) => (
                              <td key={c} className="num">
                                {(est.profile.mix[ap][c] * 100).toFixed(0)}%
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {on.plan && (
              <section className="stack-sm" aria-labelledby="r-plan">
                <h3 id="r-plan">Recommended signal plan</h3>
                <p>
                  The SignalTwin plan adapts every second. Over a {Math.round(sims.nw.t / 60)} minute {SCENARIOS[view].name.toLowerCase()} run its green times varied as shown. The Webster fixed plan is listed alongside for comparison.
                </p>
                <div className="table-wrap">
                  <table className="table" aria-label="Recommended plan">
                    <thead>
                      <tr>
                        <th>Phase</th>
                        <th className="num">SignalTwin green, shortest</th>
                        <th className="num">Mean</th>
                        <th className="num">Longest</th>
                        <th className="num">Greens given</th>
                        <th className="num">Webster fixed green</th>
                      </tr>
                    </thead>
                    <tbody>
                      {phases.map((p, i) => (
                        <tr key={i}>
                          <td>{phaseName(p)}</td>
                          <td className="num">{isFinite(greenStats[i].min) ? `${greenStats[i].min} s` : 'none'}</td>
                          <td className="num">{greenStats[i].mean.toFixed(1)} s</td>
                          <td className="num">{isFinite(greenStats[i].max) ? `${greenStats[i].max} s` : 'none'}</td>
                          <td className="num">{greenStats[i].n}</td>
                          <td className="num">{plan.greens[i]} s</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted">
                  Webster cycle {plan.cycle} s, flow ratio {plan.Y.toFixed(2)}. {plan.note}
                </p>
              </section>
            )}

            {on.compare && result && (
              <section className="stack-sm" aria-labelledby="r-cmp">
                <h3 id="r-cmp">Before and after</h3>
                <ResultTable result={result} />
              </section>
            )}

            {on.charts && (
              <section className="stack" aria-labelledby="r-ch">
                <h3 id="r-ch">Charts</h3>
                <LineChart title="Total queue over time, one seed" series={series} height={230} xLabel="Time (s)" yLabel="Queue (PCU)" xFormat={(n) => String(Math.round(n))} yFormat={(n) => n.toFixed(0)} unit="PCU" />
                {result && <StripPlot title="Average delay in each seed" groups={(['observed', 'webster', 'signaltwin'] as const).map((k) => ({ label: k === 'observed' ? 'Observed' : k === 'webster' ? 'Webster' : 'SignalTwin', values: result.perController[k]!.map((m) => m.avgDelayVeh), tone: k === 'signaltwin' ? ('new' as const) : k === 'webster' ? ('old' as const) : ('ink' as const) }))} unit="Seconds per vehicle" />}
              </section>
            )}

            {on.log && (
              <section className="stack-sm" aria-labelledby="r-log">
                <h3 id="r-log">Decision log excerpt</h3>
                <div className="table-wrap">
                  <table className="table" aria-label="Decision log excerpt">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Action</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sims.nw.decisions.slice(0, 10).map((d, i) => (
                        <tr key={i}>
                          <td className="tnum">{mmss(d.t)}</td>
                          <td>{d.action}</td>
                          <td>{d.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {on.assume && (
              <section className="stack-sm" aria-labelledby="r-as">
                <h3 id="r-as">Assumptions and limitations</h3>
                <ul>
                  <li>Vehicle size (PCU) and people per vehicle are adjustable assumptions from common practice, not measurements.</li>
                  <li>
                    Saturation flow is {params.satFlowPerLane} PCU per hour per lane{calibrated ? ', set by an accepted twin calibration' : ', the documented default unless measured on the Demand page'}.
                  </li>
                  <li>The simulator is queue based. It does not model lane changes, car following or turning movements.</li>
                  <li>Short clips are repeated to build a longer scenario. Surges are created by a load multiplier.</li>
                  <li>The controller weights and the 60 percent switching margin were tuned by grid search in this simulator, not on a real junction.</li>
                  <li>Results depend on the demand and timing entered. Hardware integration and live camera feeds are out of scope.</li>
                </ul>
              </section>
            )}
          </article>
        </div>
      </div>
      <Footer />
    </>
  );
}

