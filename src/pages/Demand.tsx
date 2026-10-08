import { useEffect, useMemo, useRef, useState } from 'react';
import { APPROACH_NAMES, APPROACHES, VEHICLE_CLASSES, type DemandEstimate, type VehicleClass } from '../contracts';
import { useApp } from '../store/app';
import { api } from '../api';
import { DEFAULT_CLASSES } from '../engine/params';
import { applyMultipliers, avgPcu, extendProfile } from '../engine/demand';
import { Histogram, LineChart, MixBars, type Series } from '../components/charts';
import { Badge, Button, Check, DataTable, EmptyState, ErrorState, NumberField, PageHeader, SelectField, SkeletonChart, SkeletonTable, SliderField, toast, useConfirm, type Column } from '../components/ui';
import { downloadText, toCsv } from '../lib/util';
import { Footer } from '../shell/Layout';
import { demoOf } from '../demos';

const SERIES_TONES = ['new', 'old', 'ink', 'new'] as const;
const DASHES = [undefined, undefined, '6 4', '2 4'];

export default function Demand() {
  const params = useApp((s) => s.params);
  const setParams = useApp((s) => s.setParams);
  const junction = useApp((s) => s.junction);
  const countsRows = useApp((s) => s.countsRows);
  const perception = useApp((s) => s.perception);
  const setDemand = useApp((s) => s.setDemand);
  const setAppliedDemand = useApp((s) => s.setAppliedDemand);
  const appliedAt = useApp((s) => s.appliedDemandAt);
  const { ask, node } = useConfirm();

  const source = junction.source === 'counts' && countsRows.length ? 'counts' : junction.source === 'video' && perception ? 'perception' : 'sample';
  const [bin, setBin] = useState(params.binSeconds);
  const [alpha, setAlpha] = useState(params.smoothing);
  const [show, setShow] = useState([true, true, true, true]);
  const [raw, setRaw] = useState<string>('none');
  const [est, setEst] = useState<DemandEstimate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [horizonMin, setHorizonMin] = useState(Math.round(params.horizon / 60));
  const [mult, setMult] = useState([1, 1, 1, 1]);
  const [surge, setSurge] = useState({ on: false, ap: 0, from: 5, to: 10, mult: 2 });
  const [useSat, setUseSat] = useState(true);
  const first = useRef(true);

  useEffect(() => {
    let live = true;
    setErr(null);
    const run = async () => {
      try {
        const src = source === 'counts' ? { kind: 'counts' as const, rows: countsRows } : source === 'perception' && perception ? { kind: 'perception' as const, result: perception } : { kind: 'sample' as const };
        const e = await api.estimateDemand(src, junction, params, alpha, bin);
        if (live) setEst(e);
      } catch (ex) {
        if (live) setErr((ex as Error).message);
      }
    };
    const id = window.setTimeout(run, first.current ? 350 : 150);
    first.current = false;
    return () => {
      live = false;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, bin, alpha, params.classes, tick, countsRows.length, perception]);

  const preview = useMemo(() => {
    if (!est) return null;
    const horizon = horizonMin * 60;
    const ext = extendProfile(est.profile, horizon);
    return applyMultipliers(ext, mult, surge.on ? [{ approach: surge.ap, from: surge.from * 60, to: surge.to * 60, mult: surge.mult }] : []);
  }, [est, horizonMin, mult, surge]);

  const series: Series[] = useMemo(() => {
    if (!preview || !est) return [];
    const out: Series[] = [];
    APPROACHES.forEach((a, ap) => {
      if (!show[ap]) return;
      out.push({
        id: a,
        label: APPROACH_NAMES[a],
        data: preview.rates[ap].map((r, b) => [(b + 0.5) * preview.binSeconds, r * avgPcu(preview.mix[ap], params)] as [number, number]),
        tone: SERIES_TONES[ap],
        dash: DASHES[ap],
        width: 2.5,
      });
    });
    if (raw !== 'none') {
      const ap = APPROACHES.indexOf(raw as (typeof APPROACHES)[number]);
      if (ap >= 0 && est.rawPcu[ap])
        out.push({
          id: `raw${ap}`,
          label: `${APPROACH_NAMES[APPROACHES[ap]]} raw bins`,
          data: est.rawPcu[ap].map((v, b) => [(b + 0.5) * est.binSeconds, v] as [number, number]),
          tone: 'ink',
          dash: '2 3',
          width: 1.2,
          step: true,
        });
    }
    return out;
  }, [preview, est, show, raw, params]);

  const mixRows = est ? est.profile.mix.map((m, ap) => ({ label: APPROACH_NAMES[APPROACHES[ap]], parts: VEHICLE_CLASSES.map((c) => m[c]) })) : [];

  const classCols: Column<VehicleClass>[] = [
    { key: 'cls', label: 'Class', render: (c) => params.classes[c].label },
    {
      key: 'pcu',
      label: 'PCU',
      num: true,
      render: (c) => (
        <div style={{ width: 120, marginLeft: 'auto' }}>
          <NumberField hideLabel label={`${params.classes[c].label} PCU`} value={params.classes[c].pcu} min={0.1} max={10} step={0.05} changed={params.classes[c].pcu !== DEFAULT_CLASSES[c].pcu} onChange={(n) => setParams({ classes: { ...params.classes, [c]: { ...params.classes[c], pcu: n } } })} />
        </div>
      ),
    },
    {
      key: 'ppl',
      label: 'People per vehicle (assumption)',
      num: true,
      render: (c) => (
        <div style={{ width: 120, marginLeft: 'auto' }}>
          <NumberField hideLabel label={`${params.classes[c].label} people`} value={params.classes[c].people} min={0.5} max={120} step={0.1} changed={params.classes[c].people !== DEFAULT_CLASSES[c].people} onChange={(n) => setParams({ classes: { ...params.classes, [c]: { ...params.classes[c], people: n } } })} />
        </div>
      ),
    },
  ];

  const apply = async () => {
    if (!preview || !est) return;
    if (source === 'sample' && !(await ask('Apply sample demand', 'This replaces the demand used by every simulation with the profile shown here. The sample junction uses generated traffic.', 'Apply demand'))) return;
    setDemand(preview);
    setAppliedDemand(new Date().toISOString());
    const patch: Partial<typeof params> = { binSeconds: bin, smoothing: alpha, horizon: horizonMin * 60 };
    if (useSat && !est.satFlow.isDefault) {
      patch.satFlowPerLane = Math.round(est.satFlow.perLane);
      patch.startupLost = Math.round(est.satFlow.startupLost * 10) / 10;
    }
    setParams(patch);
    toast('Demand applied to the junction.');
  };

  const exportCsv = () => {
    if (!preview) return;
    const rows: (string | number)[][] = [['time_s', ...APPROACHES.map((a) => `${a}_veh_per_s`), ...APPROACHES.map((a) => `${a}_pcu_per_s`)]];
    for (let b = 0; b < preview.rates[0].length; b++) {
      rows.push([(b * preview.binSeconds).toFixed(0), ...preview.rates.map((r) => r[b].toFixed(4)), ...preview.rates.map((r, ap) => (r[b] * avgPcu(preview.mix[ap], params)).toFixed(4))]);
    }
    downloadText('signaltwin-demand.csv', toCsv(rows));
    toast('Demand exported as CSV.');
  };

  const sat = est?.satFlow;

  return (
    <>
      <div className="page page-wide">
        <PageHeader
          title="Demand"
          lede="Turn counts into demand the simulator can replay: arrival rates weighted by vehicle size, the class mix, and how fast a queue discharges."
          actions={
            <>
              <Button variant="secondary" onClick={() => setTick((n) => n + 1)}>
                Recompute
              </Button>
              <Button variant="secondary" icon="download" onClick={exportCsv} disabled={!preview} disabledReason="Compute the demand first.">
                Export demand CSV
              </Button>
              <Button variant="primary" onClick={apply} disabled={!preview} disabledReason="Compute the demand first.">
                Apply to junction
              </Button>
            </>
          }
        />
        <div className="row" style={{ marginBottom: 16 }}>
          <Badge tone={source === 'sample' ? 'paint' : 'plain'}>{source === 'sample' ? 'Sample junction data' : source === 'counts' ? 'Your counts file' : 'Your perception file'}</Badge>
          {appliedAt && <span className="muted">Applied {new Date(appliedAt).toLocaleString()}.</span>}
          {demoOf(junction.id) && <span className="muted">This example's simulations use the busy-hour traffic assumed for it (see Perception), not the few seconds of counts below. Pressing Apply replaces it with these counts.</span>}
          {!appliedAt && <span className="muted">Not applied yet. Simulations use the built-in demand until you press Apply to junction.</span>}
        </div>

        {err && <ErrorState title="The demand could not be computed" body={err} onRetry={() => setTick((n) => n + 1)} />}
        {!err && !est && (
          <div className="panel stack">
            <SkeletonChart height={260} />
            <SkeletonTable rows={4} cols={4} />
          </div>
        )}
        {est && preview && (
          <div className="stack">
            <section className="panel stack" aria-labelledby="ap-h">
              <h2 id="ap-h">Arrival profile</h2>
              <div className="controls" style={{ padding: 0, background: 'transparent' }}>
                <SelectField label="Bin size" value={String(bin)} onChange={(v) => setBin(Number(v))} options={[5, 10, 15, 30, 60].map((n) => ({ value: String(n), label: `${n} s` }))} />
                <SliderField label="Smoothing strength" value={alpha} min={0.05} max={1} step={0.05} format={(n) => (n >= 0.95 ? 'Off' : n.toFixed(2))} onChange={setAlpha} />
                <div className="field">
                  <span className="field-label">Show approaches</span>
                  <div className="row">
                    {APPROACHES.map((a, i) => (
                      <Check key={a} label={APPROACH_NAMES[a]} checked={show[i]} onChange={(v) => setShow(show.map((x, j) => (j === i ? v : x)))} />
                    ))}
                  </div>
                </div>
                <SelectField label="Show raw bins for" value={raw} onChange={setRaw} options={[{ value: 'none', label: 'None' }, ...APPROACHES.map((a) => ({ value: a, label: APPROACH_NAMES[a] }))]} />
              </div>
              <LineChart title="Demand in PCU per second" series={series} height={280} xLabel="Time (s)" yLabel="PCU per second" xFormat={(n) => String(Math.round(n))} yFormat={(n) => n.toFixed(2)} unit="PCU per second" />
              {series.length === 0 && <EmptyState title="Every approach is hidden" body="Switch at least one approach back on to see its profile." />}
            </section>

            <div className="home-pair" style={{ alignItems: 'start' }}>
              <section className="panel" aria-labelledby="mix-h">
                <h2 id="mix-h" className="sr-only">
                  Class mix
                </h2>
                <MixBars title="Class mix by approach" rows={mixRows} keys={VEHICLE_CLASSES.map((c) => params.classes[c].label)} />
              </section>
              <section className="panel stack-sm" aria-labelledby="pcu-h">
                <div className="row-between">
                  <h2 id="pcu-h">PCU and people per vehicle</h2>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setParams({ classes: DEFAULT_CLASSES });
                      toast('Vehicle values reset to the defaults.');
                    }}
                  >
                    Reset to defaults
                  </Button>
                </div>
                <DataTable rows={VEHICLE_CLASSES.slice()} columns={classCols} rowKey={(c) => c} ariaLabel="PCU and occupancy per vehicle class" />
                <p className="muted">
                  These are adjustable defaults based on common traffic engineering practice, for example the Indian Roads Congress guidance on passenger car units. The people per vehicle numbers are assumptions. Tune them for your city.
                </p>
              </section>
            </div>

            <section className="panel stack" aria-labelledby="sat-h">
              <h2 id="sat-h">Saturation flow</h2>
              {sat && (
                <>
                  <div className="row" style={{ gap: 40 }}>
                    <div>
                      <div className="score-num tnum">{Math.round(sat.perLane)}</div>
                      <span className="score-tag">PCU per hour per lane{sat.isDefault ? ', default used' : ', measured'}</span>
                    </div>
                    <div>
                      <div className="score-num tnum">{sat.startupLost.toFixed(1)} s</div>
                      <span className="score-tag">Startup lost time</span>
                    </div>
                    <div>
                      <div className="score-num tnum">{sat.samples}</div>
                      <span className="score-tag">Stop-line headways measured</span>
                    </div>
                  </div>
                  {sat.isDefault ? (
                    <p className="field-error" style={{ color: 'var(--caution)' }}>
                      {source === 'sample' ? 'Too few saturated crossings were measured.' : 'A counts or perception file has no stop-line timestamps, or the clip is too short.'} The documented default of {params.satFlowPerLane} PCU per hour per lane is used and flagged.
                    </p>
                  ) : (
                    <p className="muted">Measured from the time between consecutive stop-line crossings while a queue discharged during green. Saturation flow is 1 divided by the average headway, in PCU.</p>
                  )}
                  {sat.headways.length > 0 && <Histogram title="Headway between stop-line crossings" values={sat.headways} bins={8} xLabel="Seconds" height={190} xFormat={(n) => n.toFixed(1)} />}
                  <Check label="Use the measured saturation flow and startup lost time when applying" checked={useSat} onChange={setUseSat} />
                </>
              )}
            </section>

            <section className="panel stack" aria-labelledby="ext-h">
              <h2 id="ext-h">Extend short clips and create surges</h2>
              <p className="muted">A short clip may not cover a whole peak. The profile repeats to the length you choose. This is a modelling choice and is stated in the report.</p>
              <div className="controls" style={{ padding: 0, background: 'transparent' }}>
                <SelectField label="Scenario length" value={String(horizonMin)} onChange={(v) => setHorizonMin(Number(v))} options={[15, 20, 30, 45, 60].map((n) => ({ value: String(n), label: `${n} minutes` }))} />
                {APPROACHES.map((a, i) => (
                  <SliderField key={a} label={`${APPROACH_NAMES[a]} load`} value={mult[i]} min={0.4} max={2.6} step={0.1} format={(n) => `${n.toFixed(1)}x`} onChange={(n) => setMult(mult.map((x, j) => (j === i ? n : x)))} />
                ))}
              </div>
              <div className="controls" style={{ padding: 0, background: 'transparent' }}>
                <Check label="Add a surge window" checked={surge.on} onChange={(v) => setSurge({ ...surge, on: v })} />
                <SelectField label="Surge on" value={String(surge.ap)} onChange={(v) => setSurge({ ...surge, ap: Number(v) })} options={APPROACHES.map((a, i) => ({ value: String(i), label: APPROACH_NAMES[a] }))} />
                <div style={{ width: 110 }}>
                  <NumberField label="From" value={surge.from} min={0} max={horizonMin} unit="min" disabled={!surge.on} onChange={(n) => setSurge({ ...surge, from: n })} />
                </div>
                <div style={{ width: 110 }}>
                  <NumberField label="To" value={surge.to} min={0} max={horizonMin} unit="min" disabled={!surge.on} onChange={(n) => setSurge({ ...surge, to: n })} />
                </div>
                <div style={{ width: 120 }}>
                  <NumberField label="Multiplier" value={surge.mult} min={1} max={5} step={0.1} disabled={!surge.on} onChange={(n) => setSurge({ ...surge, mult: n })} />
                </div>
              </div>
              <p className="muted">The chart above is the live preview of the profile with these changes.</p>
            </section>
          </div>
        )}
      </div>
      <Footer />
      {node}
    </>
  );
}

