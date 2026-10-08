"""Cache keys: the same video, drawing and options always give the same result, so it can be reused."""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from ..config import PIPELINE_VERSION, Settings
from ..models.contracts import PerceptionJobRequest
from ..perception.detector import file_sha256


@lru_cache(maxsize=16)
def _weights_sha(path: str, mtime_ns: int, size: int) -> str:
    return file_sha256(Path(path))


def model_fingerprint(settings: Settings, model_override: str | None) -> str:
    """Identify the detector. For real models this is the weights file hash, so a new model never serves old results."""
    if settings.detector in ("synthetic", "stub"):
        return f"{settings.detector}-v1"
    path = Path(model_override or settings.model_weights_5class or settings.model_weights)
    try:
        st = path.stat()
    except OSError:
        return f"missing:{path.name}"
    return _weights_sha(str(path.resolve()), st.st_mtime_ns, st.st_size)


def _round(o: Any) -> Any:
    if isinstance(o, float):
        return round(o, 4)
    if isinstance(o, dict):
        return {k: _round(v) for k, v in sorted(o.items())}
    if isinstance(o, list):
        return [_round(v) for v in o]
    return o


def cache_key(video_sha256: str, req: PerceptionJobRequest, settings: Settings) -> str:
    j = req.junction
    payload = {
        "v": PIPELINE_VERSION,
        "video": video_sha256,
        "geometry": j.geometry.model_dump(mode="json"),
        "calibration": j.calibration.model_dump(mode="json") if j.calibration else None,
        "fourPhase": j.observed.fourPhase,
        "pcu": {k: v.pcu for k, v in sorted(req.params.classes.items())},
        "lanes": req.params.lanes,
        "satFlowPerLane": req.params.satFlowPerLane,
        "startupLost": req.params.startupLost,
        "options": req.options.model_dump(mode="json"),
        "model": model_fingerprint(settings, req.options.model),
        "confidence": req.options.confidence if req.options.confidence is not None else settings.confidence,
        "procWidth": settings.max_proc_width,
        "targetFps": settings.target_fps,
    }
    blob = json.dumps(_round(payload), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()[:40]
