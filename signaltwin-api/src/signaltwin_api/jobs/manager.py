"""Job manager: a bounded queue, worker processes, cancellation, timeouts, memory cap and restart recovery.

Why processes: a hung or leaking decoder or model cannot be stopped from a thread, but a process can be killed,
which is what makes "cancel within 2 seconds", the timeout and the memory cap real.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import multiprocessing as mp
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any

import psutil

from .. import errors
from ..config import SIM_VERSION, Settings
from ..models.contracts import PerceptionJobRequest
from ..storage.base import ACTIVE_STATES, JobRecord, Storage, VideoRecord
from .keys import cache_key
from .worker import worker_main

log = logging.getLogger("signaltwin.jobs")

RUNNING_STATES = ACTIVE_STATES[1:]


def interrupted_problem() -> dict[str, Any]:
    return {
        "code": "job_failed",
        "status": 500,
        "title": "The analysis was interrupted",
        "detail": "The server restarted while this video was being analysed.",
        "fix": "Start the analysis again. Finished analyses are kept.",
        "retryable": True,
    }


class _Running:
    def __init__(self, job_id: str, proc: Any, conn: Any, started: float, timeout_s: float, result_path: Path, video_id: str = "") -> None:
        self.job_id = job_id
        self.video_id = video_id
        self.proc = proc
        self.conn = conn
        self.started = started
        self.timeout_s = timeout_s
        self.result_path = result_path


class JobManager:
    def __init__(self, settings: Settings, storage: Storage) -> None:
        self.settings = settings
        self.storage = storage
        self._ctx = mp.get_context("spawn")
        self._cv = threading.Condition()
        self._queue: deque[str] = deque()
        self._running: dict[str, _Running] = {}
        self._cancel: set[str] = set()
        self._stop = False
        self._thread: threading.Thread | None = None
        self._payloads: dict[str, dict[str, Any]] = {}
        self._monitors: dict[str, threading.Thread] = {}

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self.recover()
        self._thread = threading.Thread(target=self._dispatch_loop, name="job-dispatch", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self._cv:
            self._stop = True
            self._cv.notify_all()
        for r in list(self._running.values()):
            self._kill(r.proc)
        for t in list(self._monitors.values()):
            t.join(timeout=3)  # let them record the interruption before the storage goes away
        if self._thread:
            self._thread.join(timeout=3)

    def recover(self) -> None:
        """After a restart: jobs that were running are marked failed (retryable); jobs still waiting go back in the queue."""
        n = 0
        for job in self.storage.jobs_in_states(RUNNING_STATES):
            problem = interrupted_problem()
            self.storage.update_job(job.id, state="error", finished_at=time.time(), error=problem)
            self.storage.append_event(job.id, "error", {"problem": problem})
            n += 1
        queued = self.storage.jobs_in_states(("queued",))
        for job in queued:
            self._queue.append(job.id)
        if n or queued:
            log.info("recovered jobs", extra={"interrupted": n, "requeued": len(queued)})

    # ------------------------------------------------------------------ submit
    def submit(self, req: PerceptionJobRequest, video: VideoRecord, correlation_id: str | None = None) -> tuple[JobRecord, bool]:
        """Returns (job, reused). Raises ApiError. The caller has already validated the drawing."""
        key = cache_key(video.sha256, req, self.settings)
        request_json = {"kind": "perception", **req.model_dump(mode="json")}
        return self._enqueue(key, video.id, request_json, correlation_id, "Reused an earlier analysis of the same video and settings")

    def submit_experiment(self, body: dict[str, Any], correlation_id: str | None = None) -> tuple[JobRecord, bool]:
        """An experiment is a job with no video. Identical experiments share a result."""
        blob = json.dumps({"sim": SIM_VERSION, "req": body}, sort_keys=True, separators=(",", ":")).encode()
        key = "x" + hashlib.sha256(blob).hexdigest()[:39]
        return self._enqueue(key, "", {"kind": "experiment", "experiment": body}, correlation_id, "Reused an earlier run of the same experiment")

    def _enqueue(self, key: str, video_id: str, request_json: dict[str, Any], correlation_id: str | None, cached_message: str) -> tuple[JobRecord, bool]:
        active = self.storage.find_active_job(key)
        if active is not None:
            return active, True
        job_id = "j_" + uuid.uuid4().hex[:16]
        if self.storage.has_result(key):
            job = JobRecord(
                id=job_id, video_id=video_id, state="done", cache_key=key, request=request_json, from_cache=True,
                progress={"stage": "done", "fraction": 1.0, "message": cached_message}, finished_at=time.time(),
            )
            self.storage.create_job(job)
            self.storage.append_event(job_id, "queued", {"state": "queued", "cached": True})
            self.storage.append_event(job_id, "done", {"state": "done", "fromCache": True, "resultUrl": f"/v1/jobs/{job_id}/result"})
            return job, False
        with self._cv:
            waiting = len(self._queue)
            if waiting >= self.settings.queue_max:
                raise errors.queue_full(self._retry_after())
            job = JobRecord(id=job_id, video_id=video_id, state="queued", cache_key=key, request=request_json)
            self.storage.create_job(job)
            self.storage.append_event(job_id, "queued", {"state": "queued", "position": waiting + 1})
            self._payloads[job_id] = {"correlation_id": correlation_id}
            self._queue.append(job_id)
            self._cv.notify_all()
        return job, False

    def _retry_after(self) -> int:
        return 30 * max(1, len(self._running))

    # ------------------------------------------------------------------ cancel
    def cancel(self, job_id: str) -> JobRecord | None:
        job = self.storage.get_job(job_id)
        if job is None:
            return None
        if job.state in ("done", "error", "cancelled"):
            return job
        with self._cv:
            if job_id in self._queue:
                self._queue.remove(job_id)
                self._finish_cancel(job_id)
                return self.storage.get_job(job_id)
            self._cancel.add(job_id)
            self.storage.update_job(job_id, cancel_requested=True)
            self._cv.notify_all()
        run = self._running.get(job_id)
        if run is not None:
            self._kill(run.proc)  # the monitor thread sees the flag and records the outcome
        return self.storage.get_job(job_id)

    def _finish_cancel(self, job_id: str) -> None:
        self.storage.update_job(job_id, state="cancelled", finished_at=time.time(), cancel_requested=True)
        self.storage.append_event(job_id, "cancelled", {"state": "cancelled"})

    def cancel_for_video(self, video_id: str) -> None:
        """Stop every unfinished job of a video and wait (briefly) until its process is gone."""
        ids = [j.id for j in self.storage.jobs_in_states(ACTIVE_STATES) if j.video_id == video_id]
        for jid in ids:
            self.cancel(jid)
        deadline = time.time() + 5
        while time.time() < deadline and any(jid in self._running for jid in ids):
            time.sleep(0.05)

    # ------------------------------------------------------------------ dispatch
    def _dispatch_loop(self) -> None:
        while True:
            with self._cv:
                while not self._stop and (not self._queue or len(self._running) >= self.settings.workers):
                    self._cv.wait(timeout=1.0)
                if self._stop:
                    return
                job_id = self._queue.popleft()
            try:
                self._start_job(job_id)
            except Exception:  # noqa: BLE001 - never let the dispatcher die
                log.exception("could not start job", extra={"job_id": job_id})
                cid = uuid.uuid4().hex[:12]
                p = errors.job_failed(cid).problem(cid)
                self.storage.update_job(job_id, state="error", error=p, finished_at=time.time())
                self.storage.append_event(job_id, "error", {"problem": p})

    def _start_job(self, job_id: str) -> None:
        job = self.storage.get_job(job_id)
        if job is None or job.state != "queued":
            return
        extra = self._payloads.pop(job_id, {})
        result_path = self.storage.tmp_dir / f"{job_id}.json.gz"
        if job.request.get("kind") == "experiment":
            payload: dict[str, Any] = {
                "kind": "experiment",
                "settings": self.settings.model_dump(mode="json"),
                "experiment": job.request["experiment"],
                "result_path": str(result_path),
                "correlation_id": extra.get("correlation_id"),
            }
            self._spawn(job_id, payload, result_path, "", float(self.settings.job_timeout_min_s), "running")
            return
        video = self.storage.get_video(job.video_id)
        if video is None:
            p = errors.video_not_found(job.video_id).problem()
            self.storage.update_job(job_id, state="error", error=p, finished_at=time.time())
            self.storage.append_event(job_id, "error", {"problem": p})
            return
        req = PerceptionJobRequest.model_validate(job.request)
        timeout_s = max(float(self.settings.job_timeout_min_s), self.settings.job_timeout_factor * video.duration_s)
        payload = {
            "kind": "perception",
            "settings": self.settings.model_dump(mode="json"),
            "video_path": str(self.storage.video_file(video.id)),
            "video_id": video.id,
            "sha256": video.sha256,
            "probe": {
                "duration_s": video.duration_s, "width": video.width, "height": video.height, "fps": video.fps, "codec": video.codec,
                "rotation": video.rotation, "has_audio": video.has_audio, "start_offset_s": video.start_offset_s, "warnings": list(video.warnings),
            },
            "junction": req.junction.model_dump(mode="json"),
            "params": req.params.model_dump(mode="json"),
            "options": req.options.model_dump(mode="json"),
            "result_path": str(result_path),
            "correlation_id": extra.get("correlation_id"),
        }
        self._spawn(job_id, payload, result_path, video.id, timeout_s, "probing")

    def _spawn(self, job_id: str, payload: dict[str, Any], result_path: Path, video_id: str, timeout_s: float, first_state: str) -> None:
        parent_conn, child_conn = self._ctx.Pipe(duplex=False)
        proc = self._ctx.Process(target=worker_main, args=(payload, child_conn), name=f"worker-{job_id}", daemon=True)
        proc.start()
        child_conn.close()
        run = _Running(job_id, proc, parent_conn, time.time(), timeout_s, result_path, video_id)
        with self._cv:
            self._running[job_id] = run
        self._set_state(job_id, first_state, started_at=time.time())
        mon = threading.Thread(target=self._monitor, args=(run,), name=f"monitor-{job_id}", daemon=True)
        self._monitors[job_id] = mon
        mon.start()

    def _set_state(self, job_id: str, state: str, **fields: Any) -> None:
        self.storage.update_job(job_id, state=state, **fields)
        self.storage.append_event(job_id, "state", {"state": state})

    @staticmethod
    def _kill(proc: Any) -> None:
        try:
            if proc.is_alive():
                proc.terminate()
                proc.join(timeout=1.0)
            if proc.is_alive():
                proc.kill()
                proc.join(timeout=1.0)
        except (OSError, ValueError, AttributeError):
            pass

    # ------------------------------------------------------------------ monitor
    def _monitor(self, run: _Running) -> None:
        job_id = run.job_id
        cid = uuid.uuid4().hex[:12]
        outcome: tuple[str, Any] | None = None
        last_mem_check = 0.0
        try:
            ps = psutil.Process(run.proc.pid)
        except (psutil.Error, AttributeError, TypeError):
            ps = None
        try:
            while outcome is None:
                if job_id in self._cancel:
                    self._kill(run.proc)
                    outcome = ("cancelled", None)
                    break
                try:
                    has = run.conn.poll(0.1)
                except (OSError, EOFError):
                    has = False
                if has:
                    try:
                        msg = run.conn.recv()
                    except (EOFError, OSError):
                        msg = None
                    if msg is not None:
                        outcome = self._handle(job_id, msg) or None
                        continue
                elif not run.proc.is_alive():
                    # the process ended; take any last message that is still in the pipe
                    try:
                        if run.conn.poll(0.2):
                            msg = run.conn.recv()
                            outcome = self._handle(job_id, msg) or None
                            if outcome is not None:
                                break
                    except (EOFError, OSError):
                        pass
                    code = run.proc.exitcode
                    if self._stop:
                        outcome = ("error", interrupted_problem())
                        break
                    log.error("worker exited without a result", extra={"job_id": job_id, "exit_code": code, "correlation_id": cid})
                    outcome = ("error", errors.job_failed(cid, "The analysis process stopped unexpectedly.").problem(cid))
                    break
                now = time.time()
                if now - run.started > run.timeout_s:
                    self._kill(run.proc)
                    outcome = ("error", errors.timeout_error(int(run.timeout_s)).problem(cid))
                    break
                if ps is not None and now - last_mem_check > 1.0:
                    last_mem_check = now
                    try:
                        rss = ps.memory_info().rss
                        for ch in ps.children(recursive=True):
                            rss += ch.memory_info().rss
                        if rss > self.settings.job_memory_limit_mb * 1024 * 1024:
                            self._kill(run.proc)
                            log.error("job over memory limit", extra={"job_id": job_id, "rss_mb": rss // (1024 * 1024)})
                            outcome = ("error", errors.out_of_memory().problem(cid))
                            break
                    except psutil.Error:
                        pass
        except Exception:  # noqa: BLE001
            log.exception("monitor failed", extra={"job_id": job_id})
            self._kill(run.proc)
            outcome = ("error", errors.job_failed(cid).problem(cid))
        finally:
            kind, data = outcome or ("error", errors.job_failed(cid).problem(cid))
            self._finish(run, kind, data)

    def _handle(self, job_id: str, msg: tuple[Any, ...]) -> tuple[str, Any] | None:
        kind = msg[0]
        if kind == "state":
            self._set_state(job_id, str(msg[1]))
        elif kind == "progress":
            p = dict(msg[1])
            stage = p.get("stage")
            job = self.storage.get_job(job_id)
            if stage and job and job.state != stage and stage in ("decoding", "detecting", "running", "postprocessing"):
                self.storage.update_job(job_id, state=stage, progress=p)
                self.storage.append_event(job_id, "state", {"state": stage})
            else:
                self.storage.update_job(job_id, progress=p)
            self.storage.append_event(job_id, "progress", p)
        elif kind == "done":
            return ("done", (msg[1], msg[2]))
        elif kind == "error":
            return ("error", msg[1])
        elif kind == "cancelled":
            return ("cancelled", None)
        return None

    def _finish(self, run: _Running, kind: str, data: Any) -> None:
        job_id = run.job_id
        try:
            self._kill(run.proc)
            with contextlib.suppress(OSError):
                run.conn.close()
            now = time.time()
            if kind == "done":
                path, summary = data
                job = self.storage.get_job(job_id)
                try:
                    if job is not None:
                        self.storage.save_result_file(job.cache_key, run.video_id, Path(path))
                    self.storage.update_job(job_id, state="done", finished_at=now, progress={"stage": "done", "fraction": 1.0, "message": "Finished", **summary})
                    self.storage.append_event(job_id, "done", {"state": "done", "resultUrl": f"/v1/jobs/{job_id}/result", **summary})
                except OSError as e:
                    code = errors.disk_full() if getattr(e, "errno", None) == 28 else errors.job_failed(uuid.uuid4().hex[:12])
                    p = code.problem()
                    self.storage.update_job(job_id, state="error", finished_at=now, error=p)
                    self.storage.append_event(job_id, "error", {"problem": p})
            elif kind == "cancelled":
                self._finish_cancel(job_id)
                run.result_path.unlink(missing_ok=True)
            else:
                self.storage.update_job(job_id, state="error", finished_at=now, error=data)
                self.storage.append_event(job_id, "error", {"problem": data})
                run.result_path.unlink(missing_ok=True)
        finally:
            with self._cv:
                self._running.pop(job_id, None)
                self._monitors.pop(job_id, None)
                self._cancel.discard(job_id)
                self._cv.notify_all()

    # ------------------------------------------------------------------ introspection
    def stats(self) -> dict[str, int]:
        with self._cv:
            return {"queued": len(self._queue), "running": len(self._running), "workers": self.settings.workers, "queueMax": self.settings.queue_max}

