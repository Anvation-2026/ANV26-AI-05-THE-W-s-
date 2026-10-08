# Back end handoff

The interface talks to the engine through one object, `api`, exported from `src/api/MockApi.ts`. It implements the `SignalTwinApi` interface in `src/api/SignalTwinApi.ts`. To connect a Python back end, implement `HttpApi` in `src/api/HttpApi.ts` with the same shapes and export it as `api`. All shapes are in `src/contracts/index.ts` and are validated with Zod where they arrive from files.

## What the back end replaces

| Method | Mock today | Back end must |
| --- | --- | --- |
| `analyseVideo(file, junction, onProgress)` | Throws `NotConnectedError` for uploaded video. The sample junction uses a generated feed. | Run YOLO and ByteTrack, count line crossings, estimate speed with the saved homography, estimate queues, and return a `PerceptionResult`. Report progress. |
| `estimateDemand(source, junction, params)` | Bins counts, smooths with an exponential average, measures saturation flow from stop-line headways. | Same maths on the real counts. Return a `DemandEstimate`. |
| `runSimulation(req)` | TypeScript engine in the browser. | Optional. The Python simulator must reproduce `src/engine/sim.ts` exactly, including the order of steps and the seeded arrivals, or the numbers will differ between pages. |
| `runExperiment(req, onProgress)` | Web Worker running 20 seeds. | Optional. Stream progress. Support cancel. |
| `getJunction`, `saveJunction` | Saved in browser storage. | Persist per user. |

The interface can keep running the engine in the browser while only `analyseVideo` and storage move to the server.

## Suggested routes

```
GET  /junction                  -> JunctionConfig
PUT  /junction                  <- JunctionConfig
POST /perception                <- multipart video + JunctionConfig, progress over server-sent events -> PerceptionResult
POST /demand/estimate           <- { source, junction, params } -> DemandEstimate
POST /simulate                  <- SimRequest -> SimResult
POST /experiments               <- ExperimentRequest (SSE for progress) -> ExperimentResult
```

## The perception file

`PerceptionResult` is also what the Import perception file button reads, so the same file works offline.

```
{
  "fps": 10, "width": 1280, "height": 720,
  "frames": [ { "t": 0.0, "detections": [ { "id": 1, "cls": "car", "x": 640, "y": 360, "w": 80, "h": 50, "conf": 0.91 } ] } ],
  "counts": [ { "t": 12.4, "approach": "N", "cls": "car", "line": "upstream" } ]
}
```

`x` and `y` are the box centre in video pixels. `cls` is one of `twoWheeler`, `car`, `autoRickshaw`, `bus`, `truck`. `line` is `upstream` for arrivals and `stop` for departures. The Demand page uses the `upstream` counts. Stop-line timestamps feed the saturation flow estimate once the Demand page reads them.

## Things to keep identical

- Vehicle classes, PCU defaults and people per vehicle: `src/engine/params.ts`.
- Phase layout: N, S, E, W are indices 0 to 3. Two phases are NS and EW.
- Controllers: observed fixed, Webster fixed, VAC and SignalTwin. VAC and SignalTwin share the queue-clearance rule and the fairness guard. See `src/engine/sim.ts`.
- Red time counts every second an approach is not showing green or yellow. The exact bound is maximum green plus yellow plus two all-red periods.
- Common random numbers: arrivals depend only on the seed and the demand profile, never on the controller.
- Metrics and statistics: `src/engine/metrics.ts` (Student t interval, paired differences, Jain's index).

## Security and privacy to add

Videos are not uploaded in this version and the privacy page says so. When upload is added, update `/privacy` to state what is sent, where it is processed and how long it is kept, and show a notice in the app before anything leaves the device.
