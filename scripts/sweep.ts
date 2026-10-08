import { DEFAULT_OPTIONS, DEFAULT_PARAMS, SAMPLE_JUNCTION, SCENARIOS } from '../src/engine/params';
import { baseProfile } from '../src/engine/demand';
import { profileFor, runOne, type RunSetup } from '../src/engine/experiment';
import { statSet } from '../src/engine/metrics';
import type { Metrics } from '../src/contracts';

const rows: string[] = [];
const seeds = 8;
for (const hyst of [0.4, 0.6, 0.8]) {
  for (const beta of [1, 1.5]) {
    for (const gamma of [0.25, 0.5, 1]) {
      const params = { ...DEFAULT_PARAMS, beta, gamma, hysteresis: hyst };
      const out: string[] = [];
      for (const id of ['A', 'B'] as const) {
        const setup: RunSetup = {
          params,
          options: DEFAULT_OPTIONS,
          baseDemand: baseProfile(params, params.horizon),
          scenario: SCENARIOS[id],
          observed: SAMPLE_JUNCTION.observed,
        };
        const profile = profileFor(setup);
        const ms: Metrics[] = [];
        for (let s = 1; s <= seeds; s++) ms.push(runOne(setup, 'signaltwin', s, profile));
        const st = statSet(ms);
        out.push(`${id}: delay ${st.avgDelayVeh.mean.toFixed(1)} red ${st.longestRed.mean.toFixed(0)} p95 ${st.p95Delay.mean.toFixed(0)}`);
      }
      rows.push(`hyst ${hyst} beta ${beta} gamma ${gamma} | ${out.join(' | ')}`);
    }
  }
}
console.log(rows.join('\n'));
