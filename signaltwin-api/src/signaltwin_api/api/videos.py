"""Video upload, preview frames, streaming and deletion."""

from __future__ import annotations

import errno
import hashlib
import logging
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import cv2
from fastapi import APIRouter, Depends, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from starlette.datastructures import UploadFile

from .. import errors
from ..storage.base import VideoRecord
from ..video.decode import frame_at
from ..video.probe import probe
from .context import AppContext, client_key, guard

log = logging.getLogger("signaltwin.videos")
router = APIRouter(prefix="/v1/videos", tags=["videos"])

ALLOWED_EXT = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".ts", ".mts"}
MEDIA_TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".mts": "video/mp2t"}
CHUNK = 1024 * 1024


def clean_filename(name: str) -> str:
    name = unquote(name or "").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    return name[:120] or "video"


def pick_extension(head: bytes, filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if head[4:8] == b"ftyp":
        return suffix if suffix in (".mp4", ".m4v", ".mov") else ".mp4"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return ".webm" if suffix == ".webm" else ".mkv"
    if head[:4] == b"RIFF":
        return ".avi"
    return suffix if suffix in ALLOWED_EXT else ".mp4"


def video_view(v: VideoRecord, deduplicated: bool | None = None) -> dict[str, Any]:
    d: dict[str, Any] = {
        "videoId": v.id,
        "sha256": v.sha256,
        "filename": v.filename,
        "sizeBytes": v.size_bytes,
        "durationS": round(v.duration_s, 3),
        "width": v.width,
        "height": v.height,
        "fps": round(v.fps, 3),
        "codec": v.codec,
        "rotation": v.rotation,
        "hasAudio": v.has_audio,
        "warnings": v.warnings,
        "createdAt": v.created_at,
        "links": {"frame": f"/v1/videos/{v.id}/frame", "stream": f"/v1/videos/{v.id}/stream"},
    }
    if deduplicated is not None:
        d["deduplicated"] = deduplicated
    return d


async def _spool(request: Request, c: AppContext, tmp: Path, filename_hint: str) -> tuple[str, int, str, bytes]:
    """Write the uploaded bytes to `tmp` while hashing and enforcing the size limit. Returns (sha, size, filename, head)."""
    limit = c.settings.max_upload_bytes
    h = hashlib.sha256()
    size = 0
    head = b""
    ctype = request.headers.get("content-type", "").lower()
    filename = filename_hint
    try:
        if ctype.startswith("multipart/form-data"):
            form = await request.form(max_files=1, max_fields=4)
            up = form.get("file")
            if not isinstance(up, UploadFile):
                raise errors.invalid_request("The form has no file field named 'file'.", "Send the video as the form field 'file', or send the raw file as the request body.")
            filename = clean_filename(up.filename or filename_hint)
            with tmp.open("wb") as out:
                while True:
                    chunk = await up.read(CHUNK)
                    if not chunk:
                        break
                    if not head:
                        head = chunk[:16]
                    size += len(chunk)
                    if size > limit:
                        raise errors.video_too_large(size / 1048576, c.settings.max_upload_mb)
                    h.update(chunk)
                    out.write(chunk)
            await form.close()
        else:
            with tmp.open("wb") as out:
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    if not head:
                        head = chunk[:16]
                    size += len(chunk)
                    if size > limit:
                        raise errors.video_too_large(size / 1048576, c.settings.max_upload_mb)
                    h.update(chunk)
                    out.write(chunk)
    except OSError as e:
        if e.errno == errno.ENOSPC:
            raise errors.disk_full() from e
        raise
    return h.hexdigest(), size, filename, head


@router.post("", status_code=201)
async def upload_video(request: Request, response: Response, c: AppContext = Depends(guard)) -> dict[str, Any]:
    """Upload a video. Send the raw file as the body (preferred, streams with progress) or as multipart field 'file'."""
    wait = c.upload_limiter.check(client_key(request))
    if wait is not None:
        raise errors.rate_limited(wait)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit():
        n = int(declared)
        if n > c.settings.max_upload_bytes + 2 * CHUNK:
            raise errors.video_too_large(n / 1048576, c.settings.max_upload_mb)
        if n == 0:
            raise errors.video_unreadable("The file is empty (0 bytes).")
        if c.storage.free_bytes() < 2 * n + 200 * 1048576:
            raise errors.disk_full()
    hint = clean_filename(request.headers.get("x-filename", "video"))
    tmp = c.storage.tmp_dir / f"up_{uuid.uuid4().hex}.part"
    try:
        sha, size, filename, head = await _spool(request, c, tmp, hint)
        if size == 0:
            raise errors.video_unreadable("The file is empty (0 bytes).")
        existing = c.storage.find_video_by_sha(sha)
        if existing is not None:
            tmp.unlink(missing_ok=True)
            response.status_code = 200
            return video_view(existing, deduplicated=True)
        ext = pick_extension(head, filename)
        probe_path = tmp.with_suffix(ext)  # PyAV does not care, but a real extension helps error messages and debugging
        tmp.replace(probe_path)
        tmp = probe_path
        info = await run_in_threadpool(probe, tmp, c.settings)
        rec = VideoRecord(
            id="v_" + sha[:20], sha256=sha, filename=filename, size_bytes=size, duration_s=info.duration_s, width=info.width, height=info.height,
            fps=info.fps, codec=info.codec, rotation=info.rotation, has_audio=info.has_audio, start_offset_s=info.start_offset_s, ext=ext,
            warnings=info.warnings,
        )

        def store() -> VideoRecord:
            with c.lock_for(sha):
                again = c.storage.find_video_by_sha(sha)
                if again is not None:
                    tmp.unlink(missing_ok=True)
                    return again
                return c.storage.add_video(tmp, rec)

        stored = await run_in_threadpool(store)
        return video_view(stored, deduplicated=False)
    except OSError as e:
        if e.errno == errno.ENOSPC:
            raise errors.disk_full() from e
        raise
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _get(c: AppContext, video_id: str) -> VideoRecord:
    v = c.storage.get_video(video_id)
    if v is None:
        raise errors.video_not_found(video_id)
    return v


@router.get("/{video_id}")
async def get_video(video_id: str, c: AppContext = Depends(guard)) -> dict[str, Any]:
    return video_view(_get(c, video_id))


@router.get("/{video_id}/frame")
async def get_frame(video_id: str, t: float = 0.0, width: int = 0, c: AppContext = Depends(guard)) -> Response:
    """A JPEG of the picture at time t seconds, for drawing the junction. Full size unless `width` is given."""
    v = _get(c, video_id)
    if not (0.0 <= t <= v.duration_s + 0.5):
        raise errors.invalid_request(f"The time {t:g} s is outside the video (0 to {v.duration_s:.1f} s).", "Choose a time inside the video.")
    if width and not (64 <= width <= 3840):
        raise errors.invalid_request("The width must be between 64 and 3840 pixels.", "Ask for a width in that range, or leave it out for full size.")
    path = c.storage.video_file(video_id)

    def work() -> bytes | None:
        img = frame_at(path, min(t, max(0.0, v.duration_s - 0.05)), v.rotation, v.start_offset_s)
        if img is None:
            return None
        if width and img.shape[1] > width:
            h = max(2, int(round(img.shape[0] * width / img.shape[1])))
            img = cv2.resize(img, (width, h), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        return bytes(buf) if ok else None

    data = await run_in_threadpool(work)
    if data is None:
        raise errors.video_unreadable("No picture could be read at that time.")
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/{video_id}/stream")
async def stream_video(video_id: str, c: AppContext = Depends(guard)) -> FileResponse:
    """The stored video with Range support, so a <video> element can seek. The browser also has the original file."""
    v = _get(c, video_id)
    path = c.storage.video_file(video_id)
    return FileResponse(path, media_type=MEDIA_TYPES.get(v.ext, "application/octet-stream"), headers={"Cache-Control": "private, max-age=3600"})


@router.delete("/{video_id}", status_code=204)
async def delete_video(video_id: str, c: AppContext = Depends(guard)) -> Response:
    """Delete the video, its analyses and its results. Unfinished analyses are stopped first."""
    if c.storage.get_video(video_id) is None:
        raise errors.video_not_found(video_id)
    await run_in_threadpool(c.jobs.cancel_for_video, video_id)
    await run_in_threadpool(c.storage.delete_video, video_id)
    log.info("video deleted", extra={"video_id": video_id})
    return Response(status_code=204)
