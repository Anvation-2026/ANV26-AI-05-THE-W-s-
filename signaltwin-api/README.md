# SignalTwin API

The back end of SignalTwin: it analyses junction video (detect, track, count, measure queues, waits, speeds and saturation flow), estimates demand, and runs the same simulator as the browser. It is a FastAPI service with a REST and server-sent-events API. The front end in the parent folder talks to it; see `../docs/API.md` for every endpoint.

## Run it in under ten minutes

You need Python 3.11. No ffmpeg or other system tools are needed (video is read with PyAV, which bundles what it needs).

```
cd signaltwin-api
python -m venv .venv
.venv\Scripts\pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu   # CPU build, about 200 MB. Skip on a machine with a GPU and use the default index.
.venv\Scripts\pip install -e ".[vision,dev]"
.venv\Scripts\python -c "from ultralytics.utils.downloads import attempt_download_asset as d; d('models/yolo11n.pt')"   # 5 MB model file
.venv\Scripts\python -m uvicorn signaltwin_api.main:app --port 8000
```

On macOS or Linux replace `.venv\Scripts\` with `.venv/bin/`. Then open http://localhost:8000/docs, or start the front end (`../.env.example` explains `VITE_API_URL`) and look for **Back end connected** in the top bar.

### Drone and overhead footage

The default model was trained on street-level views and finds almost nothing in video that looks straight down. For that, add a model trained on aerial footage to the `models` folder. Anything under `models/` appears in Setup as a choice of **Camera view** (names containing `aerial`, `visdrone` or `drone` are offered as overhead views):

```
mkdir modelserial
curl -L -o models/aerial/visdrone-yolo11s.pt https://huggingface.co/dronefreak/visdrone-yolo11s/resolve/main/best.pt
```

That model (AGPL-3.0, trained on the VisDrone dataset, whose own terms are for research; check them before commercial use) found 54 vehicles in a frame where the default found 2. A request can only name a model that exists in `models/`; it can never give a file path.

No model yet? `DETECTOR=synthetic` runs the pipeline with a simple colour-blob detector, which is what the tests use. It only finds the coloured rectangles in the generated test videos (`python -m signaltwin_api.testing.synth out.mp4 --junction j.json`).

## Settings

All settings are environment variables or a `.env` file; `.env.example` lists them with their defaults and a line each. The ones you are most likely to change: `ALLOWED_ORIGINS` (the front end's address), `API_KEY` (require a key), `MAX_UPLOAD_MB`, `RETENTION_HOURS`, `DEVICE` (`cpu`, `cuda:0`), `MODEL_WEIGHTS`, `WORKERS`.

## What it does with a video

1. **Upload** streams to disk with a running hash. Identical files are stored once. The file is probed: format, duration, size, rotation, and a real decode of the first frames, so a broken file is refused with a plain message before any work is queued.
2. **Job.** The drawing is validated first. The job runs in its own process, so it can be cancelled in under 2 seconds, stopped at a time limit, and stopped if it uses too much memory. Progress is stored as events and streamed.
3. **Pipeline.** Frames are chosen by timestamp (about 10 per second), detected, tracked with ByteTrack, and turned into counts, queues, waits, speeds and saturation flow by the rules in `../docs/PERCEPTION.md`.
4. **Result** is cached by the video hash, the drawing, the options and the model file's hash.

## Tests

```
.venv\Scripts\python -m pytest                # everything except the real-model test
.venv\Scripts\python -m pytest -m real_yolo   # real YOLO smoke test (needs models/yolo11n.pt and network once for a sample picture)
.venv\Scripts\python -m ruff check src tests
.venv\Scripts\python -m mypy src
```

The suite includes golden files written by the front end's engine (`npm run fixtures` in the parent folder). They make the demand estimate, the saturation measurement and the simulator agree with the browser to rounding, and the decision log word for word. `python scripts/measure.py` measures accuracy against synthetic ground truth and speed with the real model, and writes `../docs/MEASUREMENTS.md`.

## Licence note

Ultralytics YOLO is AGPL-3.0. If you offer this service over a network, the AGPL's source-sharing terms apply to the combined work. Either publish your source under AGPL-3.0, buy an Ultralytics enterprise licence, or swap the detector: everything sits behind the `Detector` protocol in `perception/detector.py`, and a model that exports to ONNX can be added without touching the pipeline.

## Layout

```
src/signaltwin_api/
  main.py            app factory, CORS, middleware
  api/               routes: videos, jobs, demand and junction, simulation
  perception/        detector, tracker, geometry, analysis, pipeline
  video/             probe and decode (PyAV)
  jobs/              job manager, worker process, cache keys
  storage/           local (disk and SQLite) and Supabase adapters
  demand/            demand estimation (port of src/engine/demand.ts)
  sim/               simulator (port of src/engine/sim.ts and friends)
  testing/synth.py   synthetic junction video with exact ground truth
supabase/migrations  schema, row level security, buckets
tests/               unit, API, parity and end-to-end tests
```
