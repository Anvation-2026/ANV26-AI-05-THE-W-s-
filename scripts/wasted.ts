import { DEFAULT_OPTIONS, DEFAULT_PARAMS, SAMPLE_JUNCTION, SCENARIOS } from '../src/engine/params';
import { baseProfile } from '../src/engine/demand';
import { makeSim, profileFor, type RunSetup } from '../src/engine/experiment';
import type { ControllerKind } from '../src/contracts';

const p = DEFAULT_PARAMS;
const setup: RunSetup = { params: p, options: DEFAULT_OPTIONS, baseDemand: baseProfile(p, p.horizon), scenario: SCENARIOS.A, observed: SAMPLE_JUNCTION.observed };
const profile = profileFor(setup);
for (const kind of ['observed', 'webster', 'vac', 'signaltwin'] as ControllerKind[]) {
  let wasted = 0, worst = 0, seconds = 0, bigQueue = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const sim = makeSim(setup, kind, seed, profile).run();
    for (let t = 0; t < sim.t; t++) {
      const green = [0, 1, 2, 3].filter((ap) => sim.lampSeries[ap][t] === 2);
      const red = [0, 1, 2, 3].filter((ap) => sim.lampSeries[ap][t] === 0);
      const qGreen = green.reduce((s, ap) => s + sim.qSeries[ap][t], 0);
      const qRed = red.reduce((s, ap) => s + Math.max(0, sim.qSeries[ap][t]), 0);
      const maxRedQ = Math.max(0, ...red.map((ap) => sim.qSeries[ap][t]));
      // wasted green: the green road is empty while a red road has a queue of 10 PCU or more
      if (green.length && qGreen < 0.5 && maxRedQ >= 10) wasted++;
      if (maxRedQ >= 20) bigQueue++;
      worst = Math.max(worst, maxRedQ);
      seconds++;
    }
  }
  console.log(kind.padEnd(11), 'wasted green:', ((wasted / seconds) * 100).toFixed(1).padStart(5), '% of the time | red-road queue over 20 PCU:', ((bigQueue / seconds) * 100).toFixed(1).padStart(5), '% | worst queue', worst.toFixed(0), 'PCU');
}
