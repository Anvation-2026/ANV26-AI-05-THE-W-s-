import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { VEHICLE_CLASSES, type Params } from '../contracts';
import { DEFAULT_CLASSES, DEFAULT_PARAMS, SCENARIOS } from '../engine/params';
import { useApp } from '../store/app';
import { Button, Dialog, FileDrop, NumberField, PageHeader, Toggle, toast, useConfirm } from '../components/ui';
import { downloadText } from '../lib/util';
import { Footer } from '../shell/Layout';

type NumKey = Exclude<keyof Params, 'classes' | 'fourPhase'>;
interface Spec {
  key: NumKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  group: string;
  source: string;
  scale?: number; // display scale, 100 for percent
}

const SPECS: Spec[] = [
  { key: 'yellow', label: 'Yellow', unit: 's', min: 1, max: 10, step: 0.5, group: 'Junction timing', source: 'Common urban practice is 3 to 4 s. Match your signal.' },
  { key: 'allRed', label: 'All red clearance', unit: 's', min: 0, max: 10, step: 0.5, group: 'Junction timing', source: 'Short clearance when every approach is red. Match your signal.' },
  { key: 'minGreen', label: 'Minimum green', unit: 's', min: 5, max: 60, step: 1, group: 'Junction timing', source: 'Avoids flicker. A project default, tune locally.' },
  { key: 'maxGreen', label: 'Maximum green', unit: 's', min: 10, max: 180, step: 1, group: 'Junction timing', source: 'Prevents hogging. With the cap it sets the fairness guarantee.' },
  { key: 'fairnessCap', label: 'Fairness cap', unit: 's without green', min: 30, max: 240, step: 5, group: 'Junction timing', source: 'The problem sheet asks for a minimum wait guarantee. Default 60 s.' },
  { key: 'satFlowPerLane', label: 'Saturation flow', unit: 'PCU per hour per lane', min: 900, max: 2600, step: 10, group: 'Junction timing', source: 'About 1800 is a typical starting value. Measure it on the Demand page.' },
  { key: 'lanes', label: 'Inbound lanes per approach', unit: 'lanes', min: 1, max: 4, step: 1, group: 'Junction timing', source: 'The sample junction has two.' },
  { key: 'startupLost', label: 'Startup lost time', unit: 's', min: 0, max: 6, step: 0.5, group: 'Junction timing', source: 'About 2 s is typical. Measured on the Demand page when possible.' },
  { key: 'travelMin', label: 'Travel time, fastest', unit: 's', min: 3, max: 30, step: 1, group: 'Demand and travel', source: 'Upstream line to the back of the queue at free flow.' },
  { key: 'travelMax', label: 'Travel time, slowest', unit: 's', min: 3, max: 40, step: 1, group: 'Demand and travel', source: 'Upstream line to the back of the queue at free flow.' },
  { key: 'binSeconds', label: 'Demand bin size', unit: 's', min: 5, max: 120, step: 5, group: 'Demand and travel', source: 'Counts are grouped in bins this long. 15 s is the project default.' },
  { key: 'smoothing', label: 'Smoothing strength', unit: 'alpha, 1 is none', min: 0.05, max: 1, step: 0.05, group: 'Demand and travel', source: 'Exponentially weighted moving average weight.' },
  { key: 'beta', label: 'Weight of arrivals, beta', unit: '', min: 0, max: 4, step: 0.1, group: 'Controller', source: 'Tuned by grid search in this simulator.' },
  { key: 'gamma', label: 'Weight of aging, gamma', unit: '', min: 0, max: 4, step: 0.1, group: 'Controller', source: 'Tuned by grid search in this simulator.' },
  { key: 'lookaheadH', label: 'Look-ahead horizon', unit: 's', min: 4, max: 16, step: 1, group: 'Controller', source: 'The project notes suggest about 8 to 10 s.' },
  { key: 'hysteresis', label: 'Switching margin', unit: 'percent', min: 0, max: 150, step: 5, group: 'Controller', source: 'The project notes suggest about 15 percent. In this queue model 60 percent switched less often and gave lower delay.', scale: 100 },
  { key: 'vacGap', label: 'VAC passage time', unit: 's', min: 1, max: 8, step: 0.5, group: 'Controller', source: 'Vehicle-actuated control: a gap between vehicles longer than this ends the green. Common detector setting, 2 to 4 s.' },
  { key: 'seeds', label: 'Random seeds per comparison', unit: 'seeds', min: 3, max: 40, step: 1, group: 'Experiments', source: 'The project plan uses 20.' },
  { key: 'horizon', label: 'Simulated length', unit: 's', min: 300, max: 7200, step: 60, group: 'Experiments', source: 'Each run covers this much traffic. 1800 s is 30 minutes.' },
];

export default function Parameters() {
  const params = useApp((s) => s.params);
  const setParams = useApp((s) => s.setParams);
  const resetParams = useApp((s) => s.resetParams);
  const resetSample = useApp((s) => s.resetSample);
  const { ask, node } = useConfirm();
  const [q, setQ] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const list = SPECS.filter((s) => !ql || `${s.label} ${s.group} ${s.source} ${s.unit}`.toLowerCase().includes(ql));
    const map = new Map<string, Spec[]>();
    for (const s of list) map.set(s.group, [...(map.get(s.group) ?? []), s]);
    return map;
  }, [q]);
  const showClasses = !q.trim() || 'vehicle class pcu people occupancy'.includes(q.trim().toLowerCase());
  const changedCount = SPECS.filter((s) => params[s.key] !== DEFAULT_PARAMS[s.key]).length + VEHICLE_CLASSES.filter((c) => params.classes[c].pcu !== DEFAULT_CLASSES[c].pcu || params.classes[c].people !== DEFAULT_CLASSES[c].people).length + (params.fourPhase !== DEFAULT_PARAMS.fourPhase ? 1 : 0);

  const resetGroup = (g: string) => {
    const patch: Partial<Params> = {};
    for (const s of SPECS.filter((x) => x.group === g)) (patch as Record<string, number>)[s.key] = DEFAULT_PARAMS[s.key] as number;
    setParams(patch);
    toast(`${g} reset to the defaults.`);
  };

  const importFile = async (f: File) => {
    setImportErr(null);
    try {
      const j = JSON.parse(await f.text()) as Partial<Params>;
      const patch: Partial<Params> = {};
      for (const s of SPECS) {
        const v = (j as Record<string, unknown>)[s.key];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !isFinite(v) || v < s.min * (s.scale ? 1 / s.scale : 1) - 1e-9 || v > s.max * (s.scale ? 1 / s.scale : 1) + 1e-9) return setImportErr(`${s.label} must be a number between ${s.min / (s.scale ?? 1)} and ${s.max / (s.scale ?? 1)}.`);
        (patch as Record<string, number>)[s.key] = v;
      }
      if (j.classes) {
        const classes = { ...params.classes };
        for (const c of VEHICLE_CLASSES) {
          const x = j.classes[c];
          if (x && typeof x.pcu === 'number' && typeof x.people === 'number' && x.pcu > 0 && x.people > 0) classes[c] = { ...classes[c], pcu: x.pcu, people: x.people };
        }
        patch.classes = classes;
      }
      if (typeof j.fourPhase === 'boolean') patch.fourPhase = j.fourPhase;
      if (!Object.keys(patch).length) return setImportErr('The file has no parameters this page recognises. Export a file from this page first.');
      setParams(patch);
      setImportOpen(false);
      toast('Parameters imported.');
    } catch {
      setImportErr('That file is not valid JSON.');
    }
  };

  return (
    <>
      <div className="page page-wide">
        <PageHeader
          title="Parameters"
          lede="Every assumption in one place, with its unit, its default and where the default comes from."
          actions={
            <>
              <Button variant="secondary" icon="upload" onClick={() => setImportOpen(true)}>
                Import
              </Button>
              <Button
                variant="secondary"
                icon="download"
                onClick={() => {
                  downloadText('signaltwin-parameters.json', JSON.stringify(params, null, 2), 'application/json');
                  toast('Parameters exported.');
                }}
              >
                Export
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  if (await ask('Reset all parameters', 'Every value on this page returns to its default. Your saved junction stays as it is.', 'Reset all', true)) {
                    resetParams();
                    toast('All parameters reset.');
                  }
                }}
              >
                Reset all
              </Button>
            </>
          }
        />
        <section className="panel-sign" aria-label="Assumptions to tune locally" style={{ marginBottom: 'var(--s-4)' }}>
          <strong>Values to tune for your city.</strong>
          <p style={{ color: 'var(--sign-ink)' }}>Vehicle size (PCU), people per vehicle, saturation flow, startup lost time, travel time and the yellow and all-red periods are assumptions from common practice. The Demand page can measure some of them from your clip.</p>
          <p style={{ color: 'var(--sign-ink)' }} className="tnum">
            {changedCount === 0 ? 'Everything is at its default.' : `${changedCount} value${changedCount === 1 ? '' : 's'} changed from the default.`}
          </p>
        </section>
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="field" style={{ minWidth: 280 }}>
            <label className="field-label" htmlFor="p-search">
              Search parameters
            </label>
            <input ref={search} id="p-search" className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="For example green, flow or cap" />
          </div>
          {q && (
            <Button variant="quiet" onClick={() => setQ('')}>
              Clear search
            </Button>
          )}
        </div>

        <div className="stack">
          {[...groups.entries()].map(([g, specs]) => (
            <section key={g} className="panel stack" aria-labelledby={`g-${g}`}>
              <div className="row-between">
                <h2 id={`g-${g}`}>{g}</h2>
                <Button variant="quiet" onClick={() => resetGroup(g)}>
                  Reset {g.toLowerCase()}
                </Button>
              </div>
              <div className="table-wrap">
                <table className="table" aria-label={g}>
                  <thead>
                    <tr>
                      <th>Parameter</th>
                      <th>Value</th>
                      <th>Default</th>
                      <th>Where the default comes from</th>
                    </tr>
                  </thead>
                  <tbody>
                    {specs.map((s) => {
                      const sc = s.scale ?? 1;
                      const val = (params[s.key] as number) * sc;
                      const def = (DEFAULT_PARAMS[s.key] as number) * sc;
                      return (
                        <tr key={s.key}>
                          <td style={{ width: 240 }}>
                            <strong>{s.label}</strong>
                          </td>
                          <td style={{ width: 280 }}>
                            <NumberField hideLabel label={`${s.label} value`} value={Math.round(val * 1000) / 1000} min={s.min} max={s.max} step={s.step} unit={s.unit} changed={val !== def} onChange={(n) => setParams({ [s.key]: n / sc } as Partial<Params>)} />
                          </td>
                          <td className="tnum">
                            {Math.round(def * 1000) / 1000} {s.unit}
                          </td>
                          <td className="muted">{s.source}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {g === 'Experiments' && (
                <Toggle label="Four-phase mode, one approach at a time" checked={params.fourPhase} onChange={(v) => setParams({ fourPhase: v })} hint="Two phases is the default, NS and EW." />
              )}
            </section>
          ))}

          {showClasses && (
            <section className="panel stack" aria-labelledby="g-classes">
              <div className="row-between">
                <h2 id="g-classes">Vehicle classes</h2>
                <Button
                  variant="quiet"
                  onClick={() => {
                    setParams({ classes: DEFAULT_CLASSES });
                    toast('Vehicle classes reset to the defaults.');
                  }}
                >
                  Reset vehicle classes
                </Button>
              </div>
              <div className="table-wrap">
                <table className="table" aria-label="Vehicle classes">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th>PCU</th>
                      <th>People per vehicle</th>
                      <th>Where the default comes from</th>
                    </tr>
                  </thead>
                  <tbody>
                    {VEHICLE_CLASSES.map((c) => (
                      <tr key={c}>
                        <td>
                          <strong>{params.classes[c].label}</strong>
                        </td>
                        <td style={{ width: 200 }}>
                          <NumberField hideLabel label={`${params.classes[c].label} PCU`} value={params.classes[c].pcu} min={0.1} max={10} step={0.05} changed={params.classes[c].pcu !== DEFAULT_CLASSES[c].pcu} onChange={(n) => setParams({ classes: { ...params.classes, [c]: { ...params.classes[c], pcu: n } } })} />
                        </td>
                        <td style={{ width: 200 }}>
                          <NumberField hideLabel label={`${params.classes[c].label} people`} value={params.classes[c].people} min={0.5} max={120} step={0.1} changed={params.classes[c].people !== DEFAULT_CLASSES[c].people} onChange={(n) => setParams({ classes: { ...params.classes, [c]: { ...params.classes[c], people: n } } })} />
                        </td>
                        <td className="muted">PCU from common traffic engineering practice. People per vehicle is an assumption.</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {!q.trim() && (
            <section className="panel stack" aria-labelledby="g-sc">
              <h2 id="g-sc">Default scenarios</h2>
              <ul>
                {(['A', 'B'] as const).map((id) => (
                  <li key={id}>
                    <strong>{SCENARIOS[id].name}.</strong> {SCENARIOS[id].description}
                  </li>
                ))}
              </ul>
              <p>
                Edit scenario definitions on the <Link to="/experiments">Experiments</Link> page.
              </p>
              <div>
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (await ask('Reset to the sample junction', 'This replaces your saved junction, parameters, demand and calibration with the built-in sample. Saved runs stay.', 'Reset to sample', true)) {
                      resetSample();
                      toast('Reset to the sample junction.');
                    }
                  }}
                >
                  Reset to the sample junction
                </Button>
              </div>
            </section>
          )}
          {groups.size === 0 && !showClasses && (
            <div className="empty">
              <h3>No parameter matches "{q}"</h3>
              <p className="muted">Try a shorter word, such as green or flow.</p>
              <Button variant="secondary" onClick={() => setQ('')}>
                Clear search
              </Button>
            </div>
          )}
        </div>
      </div>
      <Footer />
      {node}
      <Dialog open={importOpen} title="Import parameters" onClose={() => setImportOpen(false)}>
        <p>Choose a JSON file exported from this page. Values outside the allowed range are rejected.</p>
        <FileDrop accept="application/json,.json" label="Drop a JSON file here" hint="Exported from the Parameters page." onFile={importFile} error={importErr} icon="upload" />
      </Dialog>
    </>
  );
}


