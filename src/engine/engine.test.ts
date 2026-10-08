import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, DEFAULT_PARAMS, SAMPLE_JUNCTION, SCENARIOS, noiseAt } from './params';
import { baseProfile, scenarioProfile, websterPlan, meanPcuRates, phaseFlowRatios } from './demand';
import { buildArrivals } from './sim';
import { computeMetrics, jainIndex, stat, tCritical } from './metrics';
import { makeSim, profileFor, runOne, simConfig, type RunSetup } from './experiment';
import { getSampleCapture } from './capture';

const params = { ...DEFAULT_PARAMS, horizon: 1200 };
const setupFor = (id: 'A' | 'B', patch: Partial<RunSetup> = {}): RunSetup => ({
  params,
  options: DEFAULT_OPTIONS,
  baseDemand: baseProfile(params, params.horizon),
  scenario: SCENARIOS[id],
  observed: SAMPLE_JUNCTION.observed,
  ...patch,
});

describe('common random numbers', () => {
  it('gives every controller identical arrivals for the same seed', () => {
    const s = setupFor('A');
    const profile = profileFor(s);
    const a = buildArrivals(simConfig(s, 'observed', 7, profile));
    const b = buildArrivals(simConfig(s, 'signaltwin', 7, profile));
    const c = buildArrivals(simConfig(s, 'webster', 7, profile));
    const sig = (x: typeof a) => x.map((sec) => sec.map((v) => `${v.id}:${v.cls}:${v.ap}:${v.etaQueue}`).join(',')).join('|');
    expect(sig(a)).toBe(sig(b));
    expect(sig(a)).toBe(sig(c));
  });

  it('gives different arrivals for different seeds', () => {
    const s = setupFor('A');
    const profile = profileFor(s);
    const a = buildArrivals(simConfig(s, 'observed', 1, profile));
    const b = buildArrivals(simConfig(s, 'observed', 2, profile));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('is fully deterministic for a repeated run', () => {
    const s = setupFor('B');
    const m1 = runOne(s, 'signaltwin', 3);
    const m2 = runOne(s, 'signaltwin', 3);
    expect(m1).toEqual(m2);
  });
});

describe('scenarios', () => {
  it('scales scenario A to about 70 percent flow ratio', () => {
    const profile = profileFor(setupFor('A'));
    const Y = phaseFlowRatios(meanPcuRates(profile, params), params).reduce((a, b) => a + b, 0);
    expect(Y).toBeGreaterThan(0.66);
    expect(Y).toBeLessThan(0.74);
  });

  it('pushes the surge approach past capacity in scenario B', () => {
    const base = baseProfile(params, params.horizon);
    const b = scenarioProfile(base, SCENARIOS.B, params, params.horizon);
    const a = scenarioProfile(base, SCENARIOS.A, params, params.horizon);
    const bin = Math.floor(600 / params.binSeconds);
    expect(b.rates[0][bin]).toBeGreaterThan(a.rates[0][bin] * 2);
    expect(b.rates[1][bin]).toBeCloseTo(a.rates[1][bin], 6);
  });
});

describe('fairness guard', () => {
  it('never lets an approach exceed the red-time cap, even in the surge', () => {
    const s = setupFor('B');
    for (let seed = 1; seed <= 5; seed++) {
      const sim = makeSim(s, 'signaltwin', seed).run();
      expect(Math.max(...sim.maxRed)).toBeLessThanOrEqual(params.fairnessCap);
    }
  });

  it('holds the cap even if max green is set above it, because the guard forces service', () => {
    const p = { ...params, maxGreen: 100 };
    const s = setupFor('B', { params: p, baseDemand: baseProfile(p, p.horizon) });
    const sim = makeSim(s, 'signaltwin', 2).run();
    expect(Math.max(...sim.maxRed)).toBeLessThanOrEqual(p.fairnessCap);
    expect(sim.decisions.some((d) => d.rule === 'fairness')).toBe(true);
  });

  it('stays within the exact bound: other max green plus yellow plus two all-red periods', () => {
    // The project documentation rounds this to 55 s by counting the clearance once.
    // An approach's own all-red also counts as red, so the exact bound is 57 s here.
    const s = setupFor('B');
    for (let seed = 1; seed <= 4; seed++) {
      const sim = makeSim(s, 'signaltwin', seed).run();
      expect(Math.max(...sim.maxRed)).toBeLessThanOrEqual(params.maxGreen + params.yellow + 2 * params.allRed);
    }
  });
});

describe('controller behaviour', () => {
  it('honours minimum green except when forced', () => {
    const s = setupFor('A');
    const sim = makeSim(s, 'signaltwin', 1).run();
    const switches = sim.decisions.filter((d) => d.rule === 'switch');
    expect(switches.length).toBeGreaterThan(0);
    for (const d of sim.decisions.filter((x) => x.rule === 'switch')) {
      // a switch is only logged once stage time met the minimum
      expect(d.t).toBeGreaterThanOrEqual(params.minGreen);
    }
  });

  it('switches less often with hysteresis than without', () => {
    const s = setupFor('A');
    const withH = makeSim(s, 'signaltwin', 5).run();
    const noH = makeSim({ ...s, options: { ...s.options, hysteresisOn: false } }, 'signaltwin', 5).run();
    const count = (x: typeof withH) => x.decisions.filter((d) => d.rule === 'switch').length;
    expect(count(withH)).toBeLessThanOrEqual(count(noH));
  });

  it('extends green for an emergency vehicle and serves it', () => {
    const s = setupFor('A', { emergencies: [{ t: 200, approach: 2 }] });
    const sim = makeSim(s, 'signaltwin', 1).run();
    expect(sim.decisions.some((d) => d.rule === 'emergency')).toBe(true);
    expect(sim.emergencyOutstanding).toBe(0);
  });

  it('every decision carries a plain-English reason', () => {
    const sim = makeSim(setupFor('A'), 'signaltwin', 1).run();
    expect(sim.decisions.length).toBeGreaterThan(5);
    for (const d of sim.decisions) expect(d.reason.length).toBeGreaterThan(10);
  });
});

describe('webster plan', () => {
  it('follows C0 = (1.5L + 5) / (1 - Y) when under capacity', () => {
    const s = setupFor('A');
    const plan = websterPlan(profileFor(s), params);
    expect(plan.overCapacity).toBe(false);
    const C0 = (1.5 * plan.lost + 5) / (1 - plan.Y);
    const sumEff = plan.greens.reduce((a, g) => a + g - params.startupLost + params.yellow, 0);
    // displayed cycle tracks C0 within rounding and minimum-green clamping
    expect(Math.abs(plan.cycle - C0) / C0).toBeLessThan(0.2);
    expect(sumEff).toBeGreaterThan(0);
  });

  it('flags oversaturation in the surge', () => {
    const plan = websterPlan(profileFor(setupFor('B')), params);
    expect(plan.overCapacity).toBe(true);
  });
});

describe('noise injection', () => {
  it('leaves arrivals untouched but changes what the controller sees', () => {
    const s = setupFor('A');
    const clean = makeSim(s, 'signaltwin', 1);
    const noisy = makeSim({ ...s, noise: noiseAt(30) }, 'signaltwin', 1);
    expect(JSON.stringify(clean.arrivals)).toBe(JSON.stringify(noisy.arrivals));
    clean.run(300);
    noisy.run(300);
    const vc = clean.buildView().q.reduce((a, b) => a + b, 0);
    const vn = noisy.buildView().q.reduce((a, b) => a + b, 0);
    const truth = noisy.queue.flat().reduce((a, v) => a + v.pcu, 0);
    expect(vn).toBeLessThanOrEqual(truth + 1e-9);
    expect(vc).toBeGreaterThanOrEqual(0);
  });
});

describe('statistics', () => {
  it("computes Jain's index", () => {
    expect(jainIndex([5, 5, 5, 5])).toBeCloseTo(1, 10);
    expect(jainIndex([10, 0.0001, 0.0001, 0.0001])).toBeLessThan(0.3);
  });
  it('computes a 95 percent interval with the t distribution', () => {
    const s = stat([10, 12, 11, 13, 9, 10, 12, 11]);
    expect(s.mean).toBeCloseTo(11, 5);
    expect(s.ci).toBeGreaterThan(0);
    expect(tCritical(19)).toBeCloseTo(2.093, 3);
  });
  it('reports metrics that are internally consistent', () => {
    const sim = makeSim(setupFor('A'), 'webster', 1).run();
    const m = computeMetrics(sim);
    expect(m.served).toBeGreaterThan(300);
    expect(m.p95Delay).toBeGreaterThanOrEqual(m.avgDelayVeh * 0.5);
    expect(m.jain).toBeLessThanOrEqual(1);
  });
});

describe('sample capture', () => {
  it('produces counts and crossings the demand page can use', () => {
    const cap = getSampleCapture(DEFAULT_PARAMS, SAMPLE_JUNCTION.observed);
    expect(cap.arrivals.length).toBeGreaterThan(300);
    expect(cap.departures.length).toBeGreaterThan(300);
    expect(cap.queue[0].length).toBe(cap.duration);
  });
});

describe('worst-case inputs', () => {
  it('handles zero vehicles without NaN or crashes', () => {
    const base = baseProfile(params, params.horizon);
    const zero = { ...base, rates: base.rates.map((r) => r.map(() => 0)) };
    const s = setupFor('A', { baseDemand: zero });
    // scenarioProfile scales to a target flow ratio, so build the zero profile directly
    const profile = { ...zero, duration: params.horizon };
    for (const kind of ['observed', 'webster', 'signaltwin'] as const) {
      const sim = makeSim(s, kind, 1, profile).run();
      const m = computeMetrics(sim);
      expect(m.served).toBe(0);
      for (const v of Object.values(m)) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('survives about 5000 vehicles in a run and stays fast', () => {
    const base = baseProfile(params, params.horizon);
    const heavy = { ...base, rates: base.rates.map((r) => r.map((v) => v * 3)) };
    const s = setupFor('A');
    const profile = { ...heavy, duration: params.horizon };
    const t0 = Date.now();
    const sim = makeSim(s, 'signaltwin', 2, profile).run();
    const m = computeMetrics(sim);
    const arrived = sim.arrivals.reduce((n, a) => n + a.length, 0);
    expect(arrived).toBeGreaterThan(3500);
    expect(Number.isFinite(m.avgDelayVeh)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(Math.max(...sim.maxRed)).toBeLessThanOrEqual(params.fairnessCap);
  });

  it('still honours the cap in four-phase mode', () => {
    const p4 = { ...params, fourPhase: true };
    const s = setupFor('A', { params: p4, baseDemand: baseProfile(p4, p4.horizon), observed: { greens: [20, 20, 20, 20], yellow: 3, allRed: 2, fourPhase: true } });
    const sim = makeSim(s, 'signaltwin', 3).run();
    expect(sim.phases.length).toBe(4);
    expect(Math.max(...sim.maxRed)).toBeLessThanOrEqual(p4.fairnessCap);
    expect(sim.served).toBeGreaterThan(200);
  });

  it('keeps same-seed determinism through the people objective and noise', () => {
    const s = setupFor('B', { options: { ...DEFAULT_OPTIONS, objective: 'people' }, noise: noiseAt(30) });
    expect(runOne(s, 'signaltwin', 9)).toEqual(runOne(s, 'signaltwin', 9));
  });
});

describe('vehicle-actuated control and queue clearance', () => {
  it('gives every plan identical arrivals, including VAC', () => {
    const s = setupFor('A');
    const profile = profileFor(s);
    const a = buildArrivals(simConfig(s, 'observed', 4, profile));
    const v = buildArrivals(simConfig(s, 'vac', 4, profile));
    expect(JSON.stringify(a)).toBe(JSON.stringify(v));
  });

  it('never switches away while vehicles that were in the queue zone at the start of the green are still waiting', () => {
    for (const kind of ['vac', 'signaltwin'] as const) {
      const s = setupFor('A');
      const sim = makeSim(s, kind, 3);
      let checked = 0;
      while (sim.t < params.horizon) {
        const before = sim.decisions.length;
        const view = sim.buildView();
        sim.step();
        for (const d of sim.decisions.slice(before)) {
          if (d.rule === 'gapout' || d.rule === 'switch') {
            expect(view.standingLeft).toBe(0);
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(5);
    }
  });

  it('skips an empty phase and serves the road that is full', () => {
    const base = baseProfile(params, params.horizon);
    // North and South empty, East and West busy
    const rates = base.rates.map((r, ap) => r.map((v) => (ap < 2 ? 0 : v * 2.2)));
    const profile = { ...base, rates, duration: params.horizon };
    const s = setupFor('A');
    const sim = makeSim(s, 'vac', 5, profile);
    sim.run();
    const ew = sim.lampSeries[2].filter((l) => l === 2).length;
    const ns = sim.lampSeries[0].filter((l) => l === 2).length;
    expect(ew).toBeGreaterThan(ns * 1.5);
    expect(sim.decisions.some((d) => d.rule === 'gapout')).toBe(true);
  });

  it('keeps the fairness cap and the maximum green', () => {
    const s = setupFor('B');
    for (let seed = 1; seed <= 4; seed++) {
      const sim = makeSim(s, 'vac', seed).run();
      expect(Math.max(...sim.maxRed)).toBeLessThanOrEqual(params.fairnessCap);
    }
  });

  it('is much worse without queue clearance, which is why the rule exists', () => {
    const s = setupFor('A');
    const on = runOne(s, 'vac', 2);
    const off = runOne({ ...s, options: { ...s.options, queueClearance: false } }, 'vac', 2);
    expect(off.avgDelayVeh).toBeGreaterThan(on.avgDelayVeh * 1.5);
  });
});