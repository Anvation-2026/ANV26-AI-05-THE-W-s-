# SignalTwin front end

A complete front end for SignalTwin: a video-calibrated digital twin that tests an adaptive signal plan against the existing plan on identical traffic. This version has no back end. Everything runs in the browser through a mock layer that can be replaced later.

SignalTwin recommends a plan. It does not control any signal.

## Run it

```
npm install
npm run dev          # http://localhost:5173
npm run build        # typecheck and production build into dist/
npm run preview      # serve the build
```

Node 20 or newer. Chrome, Edge, Firefox and Safari current versions.

## Checks

```
npm test             # 28 engine tests (Vitest)
npm run e2e          # 26 interaction steps across every page (Playwright, needs Chrome)
npm run axe          # accessibility scan of 14 routes in light and dark
npm run worstcase    # long names, Arabic and Devanagari names, huge CSV, short video, collinear points
npm run shots        # screenshots, for example: node scripts/shots.mjs "/,/console" 1440,1024,390 light,dark
```

Run `npm run build` before `e2e`, `axe`, `worstcase` and `shots`, because they serve the built app.

## Pages

| Route | Purpose |
| --- | --- |
| `/` | Home with a live demo that needs no sign-up |
| `/setup` | Five-step junction setup: source, geometry, calibration, observed timing, review |
| `/perception` | What the system detects and counts, with a choice of signal logic on the sample feed (VAC by default) |
| `/demand` | Counts to arrival rates, class mix, saturation flow, scenario building |
| `/twin` | Checks the simulator against the clip, then accepts a calibration |
| `/controller` | Score breakdown per second, fairness meters, settings, grid search, decision log |
| `/console` | The integrated demo: live analysis, decision, proof, and the 20-seed comparison |
| `/experiments` | Scenarios, ablation, noise robustness, fairness, run history |
| `/report` | Preview and export of the deliverable |
| `/parameters` | Every assumption with unit, default and source |
| `/method` | How it works, with the exact fairness bound |
| `/terms`, `/privacy` | Terms of service and privacy policy |
| `*` | 404, plus an error page for crashes |

Keyboard shortcuts: Space play or pause, `[` and `]` speed, R restart, E emergency vehicle, `G` then a letter to go to a page, `?` for the list.

## How it is built

- Vite, React 18, TypeScript strict, React Router, Zustand with persistence, Zod, `motion` for interface motion, d3-scale and d3-shape under hand-built SVG charts. No component kit and no stock icon pack. Icons are drawn in `src/components/Icon.tsx`.
- Fonts are bundled with `@fontsource`: Overpass for headings, Atkinson Hyperlegible Next for the interface, Overpass Mono for the decision log only.
- The simulation engine is plain TypeScript in `src/engine`. Long runs go to a Web Worker (`src/engine/worker.ts`) so the interface stays responsive.
- `src/components/JunctionView.tsx` draws the plan-view junction in canvas, with left-hand traffic.

```
src/
  contracts/   data shapes shared with the future back end
  api/         SignalTwinApi interface, MockApi (browser), HttpApi (stub)
  engine/      rng, sim, controllers, metrics, demand, twin validation, experiments, worker
  components/  design system, charts, JunctionView, geometry editor
  pages/       one file per route
  shell/       layout, navigation, error page, keyboard commands
  store/       saved junction, parameters, runs, uploaded video
  styles/      tokens, base, components, pages
docs/          design decisions, button audit, back end handoff
scripts/       tuning, tests and screenshot scripts
```

## What is real and what is mocked

Real, computed in the browser: demand binning and smoothing, saturation flow from stop-line headways, the homography from four calibration points, the simulator, the three controllers, all metrics and confidence intervals, the twin validation, CSV and JSON exports.

Mocked: vehicle detection. The sample junction generates a plan-view feed whose detections have realistic jitter and confidence. For an uploaded video the page plays the real video with your geometry drawn on it. Detections appear only if you import a perception file in the format described in `src/contracts`. The app never draws fake boxes on your video.

See `docs/BACKEND_HANDOFF.md` for exactly what the back end replaces.

## Honest notes on results

- The controller defaults (beta 1.5, gamma 0.5, switching margin 60 percent) come from a grid search in this simulator (`scripts/sweep.ts`). The project notes suggest about 15 percent margin. In this queue model 15 percent switched too often and was slower than the baselines, so the default is higher.
- Four plans are compared: the observed fixed plan, the Webster fixed plan, VAC (vehicle-actuated control) and SignalTwin. With the defaults, over 20 seeds, average delay per vehicle is: Scenario A, observed 21.1 s, Webster 25.0 s, VAC 16.7 s, SignalTwin 15.0 s. Scenario B (surge), observed 86.9 s, Webster 71.5 s, VAC 65.9 s, SignalTwin 61.8 s.
- Queue clearance (hold green until the vehicles that were in the queue zone when it started have left) is what makes VAC work. Without it VAC switches back and forth and averages 43.8 s in Scenario A. It is on by default for VAC and SignalTwin and can be switched off on the Controller and Console pages.
- The trade-off in the surge: with clearance on, SignalTwin's average delay improves (61.8 s against 71.3 s without it) but the road that waits is served later, so tail delay (95th percentile 263 s against 216 s), longest wait and Jain's index (0.57 against 0.73) get worse. The Webster plan is the fairest in Scenario B. The fairness cap holds in every case.
- Wasted green, meaning green on an empty road while another road holds a queue of 10 PCU or more, happens 10.4 percent of the time under the observed fixed plan, 17.3 percent under Webster, 0.2 percent under VAC and 0.1 percent under SignalTwin (scripts/wasted.ts).
- Every figure in the app is produced by a run and labelled Sample run or Your run.
- The exact red-time bound is the other phase's maximum green plus yellow plus two all-red periods (57 s with the defaults). The project notes round it to 55 s by counting the clearance once.
