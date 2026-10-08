# SignalTwin API

Base path `/v1`. JSON in and out, camelCase fields that match `src/contracts/index.ts`. Interactive docs are served at `/docs` when the API runs.

## Conventions

- **Errors** are RFC 7807 `application/problem+json` with a plain-language `fix`:

  ```json
  {
    "type": "https://signaltwin.dev/problems/video_too_short",
    "code": "video_too_short",
    "status": 422,
    "title": "The video is too short",
    "detail": "The video is 2.0 s long. At least 3 s is needed.",
    "fix": "Use a clip of at least a few minutes so queues and signal cycles show up.",
    "correlationId": "5d3b7fe8e528"
  }
  ```

  `retryAfterS` (and a `Retry-After` header) appear on 429 responses. Every response carries `X-Correlation-Id`; send your own to trace a request.
- **Auth.** If the server sets `API_KEY`, send it as `X-API-Key` (or `?api_key=` for `<video>` and `<img>` URLs). `/v1/health` is always open.
- **CORS.** Only origins in `ALLOWED_ORIGINS` may call the API from a browser.
- **Limits.** JSON bodies are capped at `MAX_JSON_KB` (4 MB). Uploads are capped at `MAX_UPLOAD_MB` and checked while streaming. Requests per minute and uploads per hour are limited per client address.
- **Timestamps** are seconds from the start of the video, taken from the decoder, not computed from frame numbers.

## Endpoints

| Method and path | What it does |
| --- | --- |
| `GET /v1/health` | Status, version, whether the model is loaded, queue state, free disk. Open. |
| `GET /v1/limits` | Upload, duration, width, retention and queue limits, so the UI can warn before uploading. |
| `POST /v1/videos` | Upload a video (raw body or multipart `file`). Returns the video id and probe results. |
| `GET /v1/videos/{id}` | Video details. |
| `GET /v1/videos/{id}/frame?t=&width=` | JPEG of the picture at time `t`, for drawing the junction. |
| `GET /v1/videos/{id}/stream` | The stored video with Range support. |
| `DELETE /v1/videos/{id}` | Deletes the video, its analyses and results. Unfinished jobs are stopped first. |
| `POST /v1/perception/jobs` | Start analysing a video. Identical requests share one job, and a finished identical request is answered from cache. |
| `GET /v1/jobs/{id}` | Job state, progress and error. |
| `GET /v1/jobs/{id}/events` | Server-sent events with replay (`Last-Event-ID`). |
| `GET /v1/jobs/{id}/result` | The result, gzip encoded (`?download=true` for a file). |
| `POST /v1/jobs/{id}/cancel` | Stops a job within 2 seconds. Safe to repeat. |
| `POST /v1/demand/estimate` | Counts or a perception result in, a demand profile out. Same arithmetic as the browser. |
| `POST /v1/simulate` | One simulation run: metrics, decision log, queue and lamp series. |
| `POST /v1/experiments` | A comparison, ablation, noise sweep or grid search as a job. Follow it like a perception job. |
| `GET` / `PUT /v1/junction` | One saved junction (`JunctionConfig`). |

### Upload

```
POST /v1/videos
Content-Type: application/octet-stream
X-Filename: junction.mp4

<file bytes>
```

Raw bodies stream straight to disk with a running SHA-256, so progress works with `XMLHttpRequest` and nothing is held in memory. A multipart form with a `file` field also works. The same bytes uploaded twice return the same `videoId` with `deduplicated: true` and status 200. The first upload returns 201.

```json
{
  "videoId": "v_aeff6591c13eeea33e9b", "sha256": "…", "filename": "junction.mp4", "sizeBytes": 1405635,
  "durationS": 150.0, "width": 1280, "height": 720, "fps": 25.0, "codec": "h264", "rotation": 0,
  "hasAudio": false, "warnings": [], "deduplicated": false,
  "links": { "frame": "/v1/videos/v_…/frame", "stream": "/v1/videos/v_…/stream" }
}
```

### Perception job

```json
POST /v1/perception/jobs
{
  "videoId": "v_…",
  "junction": { "…": "a JunctionConfig: geometry, calibration, observed timing" },
  "params": { "lanes": 2 },
  "options": { "frameSampleS": 0.2, "startS": 0, "endS": null }
}
```

The drawing is checked first. Problems come back immediately as 422 (`geometry_incomplete`, `calibration_invalid`, `junction_invalid`), not after minutes of work. The answer is `202` with the job, or `200` when the result already exists.

Job states: `queued`, `probing`, `decoding`, `detecting`, `postprocessing`, `done`, `error`, `cancelled`.

### Events

```
id: 12
event: progress
data: {"stage":"detecting","fraction":0.42,"processed_s":63.0,"total_s":150.0,"fps":9.8,"eta_s":84.1,"message":"Analysing the video: 63 s of 150 s"}
```

Event types: `queued`, `state`, `progress`, `done`, `error` (with a `problem`), `cancelled`. Events are stored, so a client that reconnects with `Last-Event-ID` gets exactly the events it missed.

### Result

`PerceptionResult` (see `src/contracts/index.ts`): `frames` with boxes, `counts` at the upstream and stop lines, `queue` per second, `speeds`, `departures`, `waits`, `satFlow`, `quality` and `meta` (video id, hash, model name, version and hash, device, timing, warnings). Everything after `counts` is optional in the schema, so a hand-made file with frames and counts is still valid. Box `x`, `y` are the centre in pixels of the original video frame.

### Demand estimate

```json
POST /v1/demand/estimate
{ "source": { "kind": "counts", "rows": [{ "t": 0, "approach": "N", "cls": "car", "count": 4 }] },
  "params": { }, "smoothing": 0.35, "binSeconds": 15 }
```

`source.kind` is `counts` or `perception`. For `perception` only `counts`, `satFlow` and the last frame time are used, so a client may send a single stub frame instead of thousands. If an approach has no upstream counts, its stop-line counts are used and `warnings` says so.

### Simulation and experiments

`POST /v1/simulate` takes a `SimRequest` and returns a `SimResult`. The horizon is limited to 7200 s per call. `POST /v1/experiments` takes an `ExperimentRequest` (`compare`, `ablation`, `noise` or `grid`) and returns a job. Its `progress` events have `done`, `total` and `message`, and its result is an `ExperimentResult`. The Python simulator reproduces the browser's results; `tests/golden/*.json` proves it.

## Error codes

| Code | Status | Meaning and fix |
| --- | --- | --- |
| `unsupported_format` | 415 | The file is not a video. Upload MP4, MOV, MKV or WebM. |
| `video_too_large` | 413 | File or resolution over the limit. Trim or lower the resolution. |
| `video_too_short` | 422 | Under 3 s. |
| `video_too_long` | 422 | Over the duration limit. |
| `video_unreadable` | 422 | Empty, damaged, truncated or undecodable. |
| `no_video_stream` | 422 | The file has no video track. |
| `geometry_incomplete` | 422 | Fewer than two approaches have a stop line and a direction. Names what is missing. |
| `calibration_invalid` | 422 | Repeated or collinear points, crossed order, non-positive or inconsistent distances. |
| `junction_invalid` | 422 | Lines too short, outside the picture, or a zone with no area. |
| `model_unavailable` | 503 | The model file is missing or cannot be loaded. |
| `queue_full` | 429 | The waiting list or the rate limit is full. See `Retry-After`. |
| `job_not_found` | 404 | Unknown or expired id. |
| `job_not_ready` | 409 | Result asked for before the job finished. |
| `job_cancelled` | 409 | Result asked for after a cancel. |
| `job_failed` | 500 | The worker failed. Quote the `correlationId`. `retryable: true` after a restart. |
| `timeout` | 504 | The job exceeded its time limit and was stopped. |
| `out_of_memory` | 507 | The worker exceeded the memory cap and was stopped. |
| `internal_error` | 500 | Unexpected. Disk full also uses 507. |
| `experiment_too_large`, `simulation_too_long` | 422 | Reduce seeds, controllers or horizon. |
| `unauthorized` | 401 | Missing or wrong API key. |
| `invalid_request` | 422 | A field is wrong. `detail` names it. |
| `request_too_large` | 413 | JSON body over the limit. |

## Idempotency and caching

A result is keyed by the video's SHA-256, the geometry, calibration, class table, lane count, options, the model file's hash, the confidence setting and the pipeline version. Submitting the same request again returns the running job, or a finished job marked `fromCache`. Changing any of those makes a new analysis. Experiments are keyed by their request and the simulator version.

## Restart behaviour

Jobs live in SQLite. After a restart, jobs that were running are marked `error` with `retryable: true` and a fix ("Start the analysis again"). Jobs that were still waiting go back in the queue. Finished results are kept until the retention period ends.
