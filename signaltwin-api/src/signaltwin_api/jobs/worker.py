"""The code that runs inside a spawned worker process. The parent talks to it over a pipe.

Messages sent to the parent, as tuples:
  ("state", name)                     the job moved to a new stage
  ("progress", dict)                  throttled progress
  ("done", result_path, summary)      finished, the gzip file is on disk
  ("error", problem_dict)             failed with a user-explainable problem
"""

from __future__ import annotations

import contextlib
import gzip
import logging
import os
import traceback
import uuid
from dataclasses import asdict
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any


def _run_experiment(payload: dict[str, Any], conn: Connection, settings: Any) -> None:
    import time

    import orjson
    from pydantic import TypeAdapter

    from ..models.contracts import ExperimentRequest
    from ..sim.experiment import run_experiment

    req = TypeAdapter(ExperimentRequest).validate_python(payload["experiment"])
    started = time.time()
    last = [0.0]

    def progress(done: int, total: int, label: str) -> None:
        now = time.time()
        if done < total and now - last[0] < 0.25:
            return
        last[0] = now
        frac = done / total if total else 1.0
        eta = (now - started) * (1 - frac) / frac if frac > 0.02 else None
        conn.send(("progress", {"stage": "running", "fraction": round(frac, 4), "done": done, "total": total, "message": label, "eta_s": eta}))

    conn.send(("state", "running"))
    result = run_experiment(req, progress, lambda: False)
    data = orjson.dumps(result)
    out = Path(payload["result_path"])
    with out.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=6, mtime=0) as gz:
        gz.write(data)
    conn.send(("done", str(out), {"bytes": out.stat().st_size, "rawBytes": len(data), "processingS": round(time.time() - started, 2)}))


def worker_main(payload: dict[str, Any], conn: Connection) -> None:
    # Imports are inside the function so that a spawned process only pays for them once it starts working.
    import orjson

    from .. import errors
    from ..config import Settings
    from ..logging_setup import configure_logging
    from ..models.contracts import JunctionConfig, Params, PerceptionOptions
    from ..perception.detector import make_detector
    from ..perception.pipeline import Cancelled, run_perception
    from ..video.probe import ProbeInfo

    settings = Settings(**payload["settings"])
    configure_logging(settings.log_level)
    log = logging.getLogger("signaltwin.worker")
    cid = payload.get("correlation_id") or uuid.uuid4().hex[:12]
    try:
        if payload.get("kind") == "experiment":
            _run_experiment(payload, conn, settings)
            return
        junction = JunctionConfig.model_validate(payload["junction"])
        params = Params.model_validate(payload["params"])
        options = PerceptionOptions.model_validate(payload["options"])
        probe = ProbeInfo(**payload["probe"])
        conn.send(("state", "decoding"))
        detector = make_detector(settings, weights=options.model, confidence=options.confidence)
        try:

            def progress(p: Any) -> None:
                conn.send(("progress", asdict(p)))

            result = run_perception(
                Path(payload["video_path"]),
                payload["video_id"],
                payload["sha256"],
                probe,
                junction,
                params,
                options,
                detector,
                settings,
                progress=progress,
            )
        finally:
            detector.close()
        conn.send(("progress", {"stage": "postprocessing", "fraction": 1.0, "message": "Saving the result"}))
        data = orjson.dumps(result.model_dump(mode="json", exclude_none=True))
        out = Path(payload["result_path"])
        with out.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=6, mtime=0) as gz:
            gz.write(data)
        conn.send(
            (
                "done",
                str(out),
                {
                    "bytes": out.stat().st_size,
                    "rawBytes": len(data),
                    "frames": len(result.frames),
                    "counts": len(result.counts or []),
                    "processingS": result.meta.processingS if result.meta else None,
                },
            )
        )
    except Cancelled:
        conn.send(("cancelled",))
    except errors.ApiError as e:
        conn.send(("error", e.problem(cid)))
    except MemoryError:
        conn.send(("error", errors.out_of_memory().problem(cid)))
    except OSError as e:
        if getattr(e, "errno", None) == 28:  # ENOSPC
            conn.send(("error", errors.disk_full().problem(cid)))
        else:
            log.error("worker os error\n%s", traceback.format_exc(), extra={"correlation_id": cid})
            conn.send(("error", errors.job_failed(cid).problem(cid)))
    except BaseException:  # noqa: BLE001 - the parent must always hear back
        log.error("worker crashed\n%s", traceback.format_exc(), extra={"correlation_id": cid})
        conn.send(("error", errors.job_failed(cid).problem(cid)))
    finally:
        with contextlib.suppress(OSError):
            conn.close()
        os._exit(0)
