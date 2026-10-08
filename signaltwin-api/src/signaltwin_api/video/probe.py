"""Inspect a video file safely, without ever trusting its extension or content type."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

import av
import av.error

from .. import errors
from ..config import Settings

log = logging.getLogger("signaltwin.probe")

# First bytes of the containers we accept. Used only to word the error message well.
_MAGICS: tuple[tuple[int, bytes], ...] = (
    (4, b"ftyp"),  # mp4, mov, m4v
    (0, b"\x1a\x45\xdf\xa3"),  # matroska, webm
    (0, b"RIFF"),  # avi
    (0, b"OggS"),
    (0, b"\x00\x00\x01\xba"),  # mpeg ps
    (0, b"G"),  # mpeg ts sync byte
    (0, b"FLV"),
)


def looks_like_video_container(path: Path) -> bool:
    try:
        head = path.read_bytes()[:16] if path.stat().st_size < 16 else _read_head(path)
    except OSError:
        return False
    return any(head[off : off + len(sig)] == sig for off, sig in _MAGICS)


def _read_head(path: Path) -> bytes:
    with path.open("rb") as f:
        return f.read(16)


@dataclass
class ProbeInfo:
    duration_s: float
    width: int  # as displayed, after rotation
    height: int
    fps: float
    codec: str
    rotation: int = 0
    has_audio: bool = False
    start_offset_s: float = 0.0
    warnings: list[str] = field(default_factory=list)


def _rotation_of(stream: av.video.stream.VideoStream) -> int:
    """Degrees the picture must be turned clockwise to look upright. Tolerant of old and new PyAV."""
    try:
        raw = stream.metadata.get("rotate")
        if raw is not None:
            return int(float(raw)) % 360
    except (ValueError, AttributeError, TypeError):
        pass
    try:
        side = getattr(stream, "side_data", None)
        if side:
            for key in ("DISPLAYMATRIX", "Display Matrix", "displaymatrix"):
                if key in side:
                    value = side[key]
                    angle = getattr(value, "rotation", None)
                    if angle is None and isinstance(value, (int, float)):
                        angle = value
                    if angle is not None:
                        return int(round(-float(angle))) % 360
    except Exception:  # noqa: BLE001 - metadata is advisory, never fatal
        pass
    return 0


def _stream_fps(stream: av.video.stream.VideoStream) -> float:
    for rate in (stream.average_rate, stream.guessed_rate, getattr(stream, "base_rate", None)):
        if rate:
            try:
                f = float(Fraction(rate))
                if 1.0 <= f <= 240.0:
                    return f
            except (ZeroDivisionError, TypeError, ValueError):
                continue
    return 0.0


def _duration_from_packets(container: av.container.InputContainer, stream: av.video.stream.VideoStream) -> float:
    last = 0.0
    first: float | None = None
    for packet in container.demux(stream):
        if packet.dts is None and packet.pts is None:
            continue
        ts = packet.pts if packet.pts is not None else packet.dts
        if ts is None or not stream.time_base:
            continue
        t = float(ts * stream.time_base)
        if first is None:
            first = t
        last = max(last, t)
    return max(0.0, last - (first or 0.0))


def probe(path: Path, settings: Settings) -> ProbeInfo:
    """Validate and describe a video. Raises ApiError with a user-facing message."""
    try:
        size = path.stat().st_size
    except OSError as e:
        raise errors.video_unreadable("The uploaded file could not be found on the server.") from e
    if size == 0:
        raise errors.video_unreadable("The file is empty (0 bytes).")

    try:
        container = av.open(str(path), mode="r", timeout=(10.0, 10.0))
    except (av.error.FFmpegError, ValueError, OSError) as e:
        if looks_like_video_container(path):
            raise errors.video_unreadable("The file looks like a video but is damaged or cut short.") from e
        raise errors.unsupported_format("The file does not look like a video. Its contents are not a known video format.") from e

    try:
        vstreams = container.streams.video
        if len(vstreams) == 0:
            raise errors.no_video_stream()
        stream = vstreams[0]
        warnings: list[str] = []
        codec = stream.codec_context.name or "unknown"
        width = int(stream.codec_context.width or stream.width or 0)
        height = int(stream.codec_context.height or stream.height or 0)
        fps = _stream_fps(stream)
        rotation = _rotation_of(stream)
        has_audio = len(container.streams.audio) > 0

        duration = 0.0
        if container.duration:
            duration = float(container.duration) / av.time_base
        elif stream.duration and stream.time_base:
            duration = float(stream.duration * stream.time_base)
        if duration <= 0:
            try:
                duration = _duration_from_packets(container, stream)
            except (av.error.FFmpegError, OSError):
                duration = 0.0

        # prove that frames can really be decoded, so a broken file is rejected now and not after an upload wait
        decoded = 0
        container.seek(0)
        try:
            for packet in container.demux(stream):
                if decoded >= 2:
                    break
                try:
                    for _ in packet.decode():
                        decoded += 1
                        if decoded >= 2:
                            break
                except av.error.FFmpegError:
                    continue
        except av.error.FFmpegError:
            pass
        if decoded == 0:
            raise errors.video_unreadable("No picture could be decoded from the file. It may be damaged or use an unsupported codec.")

        if width <= 0 or height <= 0:
            raise errors.video_unreadable("The video has no picture size.")
        if rotation in (90, 270):
            width, height = height, width
        if fps <= 0:
            fps = 25.0
            warnings.append("The video does not state its frame rate, so 25 frames per second is assumed.")

        start = 0.0
        if stream.start_time is not None and stream.time_base:
            start = max(0.0, float(stream.start_time * stream.time_base))

        if duration < 3.0:
            raise errors.video_too_short(duration)
        if duration > settings.max_duration_s:
            raise errors.video_too_long(duration, settings.max_duration_s)
        if width > settings.max_width:
            raise errors.video_resolution_too_large(width, settings.max_width)
        if fps < 8:
            warnings.append(f"The video runs at {fps:.1f} frames per second. Fast vehicles may be missed between frames.")
        if width < 480:
            warnings.append(f"The video is only {width} pixels wide. Small vehicles may not be detected.")
        if width > settings.max_proc_width:
            warnings.append(f"The video is {width} pixels wide and is analysed at {settings.max_proc_width} pixels to keep it fast.")
        return ProbeInfo(duration, width, height, fps, codec, rotation, has_audio, start, warnings)
    except errors.ApiError:
        raise
    except (av.error.FFmpegError, OSError, ValueError) as e:
        raise errors.video_unreadable("The file could not be decoded.") from e
    finally:
        container.close()
