import { DEFAULT_OPTIONS, DEFAULT_PARAMS, SAMPLE_JUNCTION, SCENARIOS } from '../src/engine/params';
import { baseProfile, websterPlan } from '../src/engine/demand';
import { profileFor, runOne, type RunSetup } from '../src/engine/experiment';
import { statSet } from '../src/engine/metrics';
import type { ControllerKind, Metrics } from '../src/contracts';

const beta = Number(process.argv[2] ?? DEFAULT_PARAMS.beta);
const gamma = Number(process.argv[3] ?? DEFAULT_PARAMS.gamma);
const params = { ...DEFAULT_PARAMS, beta, gamma };
const variants: { label: string; kind: ControllerKind; clear: boolean }[] = [
  { label: 'observed', kind: 'observed', clear: true },
  { label: 'webster', kind: 'webster', clear: true },
  { label: 'vac (clearance on)', kind: 'vac', clear: true },
  { label: 'vac (clearance off)', kind: 'vac', clear: false },
  { label: 'signaltwin (clearance on)', kind: 'signaltwin', clear: true },
  { label: 'signaltwin (clearance off)', kind: 'signaltwin', clear: false },
];
for (const id of ['A', 'B'] as const) {
  const base: RunSetup = {
    params,
    options: DEFAULT_OPTIONS,
    baseDemand: baseProfile(params, params.horizon),
    scenario: SCENARIOS[id],
    observed: SAMPLE_JUNCTION.observed,
  };
  const profile = profileFor(base);
  const plan = websterPlan(profile, params);
  console.log(`\nScenario ${id}  beta=${beta} gamma=${gamma}  webster cycle=${plan.cycle} greens=${plan.greens}`);
  for (const v of variants) {
    const setup: RunSetup = { ...base, options: { ...base.options, queueClearance: v.clear } };
    const ms: Metrics[] = [];
    for (let s = 1; s <= 20; s++) ms.push(runOne(setup, v.kind, s, profile));
    const st = statSet(ms);
    console.log(
      v.label.padEnd(27),
      'delay', st.avgDelayVeh.mean.toFixed(1).padStart(6), '+-', st.avgDelayVeh.ci.toFixed(1),
      '| person', st.avgDelayPerson.mean.toFixed(1).padStart(6),
      '| p95', st.p95Delay.mean.toFixed(1).padStart(6),
      '| red', st.longestRed.mean.toFixed(0).padStart(3),
      '| wait', st.longestWait.mean.toFixed(0).padStart(4),
      '| thr', st.throughputVeh.mean.toFixed(0).padStart(5),
      '| maxQ', st.maxQueue.mean.toFixed(1).padStart(5),
      '| jain', st.jain.mean.toFixed(3),
    );
  }
}
