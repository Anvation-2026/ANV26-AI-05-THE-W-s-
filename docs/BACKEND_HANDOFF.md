# Back end integration

The interface talks to the engines through one object, `api`, from `src/api/index.ts`. It implements `SignalTwinApi` (`src/api/SignalTwinApi.ts`) and chooses a side for every call:

| Method | Browser (`MockApi`) | Back end (`HttpApi`) | Rule |
| --- | --- | --- | --- |
| `analyseVideo` | Not possible: throws `NotConnectedError` | Upload with progress, job, events, result | Back end only, and only when `/v1/health` says the model is loaded |
| `estimateDemand` | Sample, counts, detections | Counts and detections | Back end when it answers, browser when it does not or fails. The sample junction always stays in the browser |
| `runSimulation`, `runExperiment` | Engine in the browser, experiments in a Web Worker | `/v1/simulate`, `/v1/experiments` | Browser unless the person chose the back end in the Back end dialog |
| `deleteServerVideo` | Nothing to delete | `DELETE /v1/videos/{id}` | Never skipped silently: if the server cannot be reached the person is told |
| `getJunction`, `saveJunction` | Browser storage | Not used | The junction stays in the browser |

`src/api/backend.ts` holds the connection state. The address comes from `VITE_API_URL` at build time, or from the Back end dialog. With neither, the app never contacts a server, so there are no failed requests in the console.

## Contracts

All shapes are in `src/contracts/index.ts` (Zod and TypeScript) and `signaltwin-api/src/signaltwin_api/models/contracts.py` (Pydantic, camelCase). Keep them identical. `PerceptionSchema` accepts a hand-made file with only `frames` and `counts`; everything the back end adds (`meta`, `queue`, `speeds`, `departures`, `waits`, `satFlow`, `quality`) is optional.

## Things that must stay identical

The browser engine is the source of truth. The Python port in `signaltwin_api/sim` and `signaltwin_api/demand` reproduces it. When `src/engine` changes:

1. Change the engine and its tests.
2. Run `npm run fixtures`. This rewrites `signaltwin-api/tests/golden/*.json` from the engine.
3. Run the back end tests. Any difference shows up as a failing parity test; bring the Python port in line.

Rules that both sides share: vehicle classes, PCU and people defaults (`src/engine/params.ts`), phase layout (N, S, E, W are 0 to 3; two phases are NS and EW), the four controllers, common random numbers (arrivals depend only on the seed and the demand profile), and the metrics and statistics. The random generator and the number formatting of the decision log are ported exactly (`sim/jsnum.py`), including `Math.round` and `toFixed` behaviour.

## Clips that are not four-way junctions

Setup needs a stop line and an upstream line on at least two approaches, and calibration is optional (without it speeds are not measured). The letters N, S, E and W only name roads and put them in the two signal phases (N and S together, E and W together). `scripts/e2e-clips.mjs` takes a folder of real clips through upload, junction import, analysis, Perception, Demand, the simulation comparison and Twin in a real browser.

The fairness guard in both VAC and SignalTwin ignores an approach that has nobody waiting or about to arrive, so a four-phase junction with one busy road is not forced to give green to empty roads (it was: 593 s average delay against 251 s once fixed, on one clip).

## Privacy

Videos are uploaded only when the person presses Analyse video and agrees to the one-time notice. The Privacy page states what is sent, what the server does, how long it is kept (`RETENTION_HOURS`), and has Delete my video and results. If you host the back end, update that page to match your storage and backups.

## What is not covered

- Accuracy on real footage. The stock YOLO model has no auto-rickshaw class; they are reported as cars or two-wheelers and the quality report says so. A fine-tuned five-class model can be given with `MODEL_WEIGHTS_5CLASS`.
- Ultralytics (YOLO) is AGPL-3.0. Hosting it as a network service has licence consequences; read `signaltwin-api/README.md` before deploying.
- Accounts and per-user storage. There is one anonymous owner; the optional API key is a shared secret, not a login.
