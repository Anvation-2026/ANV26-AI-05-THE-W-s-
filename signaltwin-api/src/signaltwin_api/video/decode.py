"""Decode frames with their real presentation timestamps, in bounded memory."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import av
import av.error
import cv2
import numpy as np

log = logging.getLogger("signaltwin.decode")


@dataclass
class Frame:
    t: float  # seconds from the start of the video, from the decoder
    index: int  # running number of frames kept
    image: np.ndarray  # BGR, at processing size


@dataclass
class DecodeStats:
    decoded: int = 0
    kept: int = 0
    corrupt_skipped: int = 0
    last_t: float = 0.0


def apply_rotation(img: np.ndarray, rotation: int) -> np.ndarray:
    """Turn the picture `rotation` degrees clockwise (0, 90, 180 or 270)."""
    r = rotation % 360
    if r == 90:
        return np.ascontiguousarray(np.rot90(img, k=-1))
    if r == 180:
        return np.ascontiguousarray(np.rot90(img, k=2))
    if r == 270:
        return np.ascontiguousarray(np.rot90(img, k=1))
    return img


def processing_scale(display_width: int, max_proc_width: int) -> float:
    return min(1.0, max_proc_width / float(display_width)) if display_width > 0 else 1.0


def iter_frames(
    path: Path,
    *,
    fps_hint: float,
    rotation: int,
    start_offset_s: float,
    target_fps: float,
    scale: float,
    start_s: float = 0.0,
    end_s: float | None = None,
    cancelled: Callable[[], bool] | None = None,
    stats: DecodeStats | None = None,
) -> Iterator[Frame]:
    """Yield about `target_fps` frames per second, chosen by timestamp so variable frame rate is handled.

    Corrupt packets are skipped and counted. Only one decoded frame is held at a time.
    """
    stats = stats if stats is not None else DecodeStats()
    interval = 1.0 / max(0.5, target_fps)
    container = av.open(str(path), mode="r", timeout=(10.0, 10.0))
    try:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        time_base = stream.time_base
        if start_s > 0 and time_base:
            try:
                container.seek(int((start_s + start_offset_s) / float(time_base)), stream=stream, backward=True, any_frame=False)
            except av.error.FFmpegError:
                container.seek(0)
        next_t = start_s
        index = 0
        last_t = -1.0
        for packet in container.demux(stream):
            if cancelled and cancelled():
                return
            try:
                frames = packet.decode()
            except av.error.FFmpegError:
                stats.corrupt_skipped += 1
                continue
            for fr in frames:
                stats.decoded += 1
                if fr.pts is not None and time_base is not None:
                    t = float(fr.pts * time_base) - start_offset_s
                elif fr.time is not None:
                    t = float(fr.time) - start_offset_s
                else:
                    t = last_t + 1.0 / max(1.0, fps_hint)
                t = max(0.0, t)
                if t <= last_t:  # non-monotonic timestamps after a bad seek: keep the clock moving forward
                    t = last_t + 1e-3
                last_t = t
                stats.last_t = t
                if end_s is not None and t > end_s:
                    return
                if t + 1e-6 < next_t:
                    continue
                try:
                    img = fr.to_ndarray(format="bgr24")
                except (av.error.FFmpegError, ValueError):
                    stats.corrupt_skipped += 1
                    continue
                img = apply_rotation(img, rotation)
                if scale < 0.999:
                    h, w = img.shape[:2]
                    img = np.asarray(cv2.resize(img, (max(2, int(round(w * scale))), max(2, int(round(h * scale)))), interpolation=cv2.INTER_AREA), dtype=np.uint8)
                yield Frame(t=t, index=index, image=img)
                index += 1
                stats.kept += 1
                next_t += interval
                if t >= next_t:  # we fell behind (low fps source), do not try to catch up
                    next_t = t + interval
    finally:
        container.close()


def frame_at(path: Path, t: float, rotation: int, start_offset_s: float) -> np.ndarray | None:
    """The picture at time t, at full original size, for drawing geometry accurately."""
    container = av.open(str(path), mode="r", timeout=(10.0, 10.0))
    try:
        stream = container.streams.video[0]
        tb = stream.time_base
        if t > 0 and tb:
            try:
                container.seek(int((t + start_offset_s) / float(tb)), stream=stream, backward=True, any_frame=False)
            except av.error.FFmpegError:
                container.seek(0)
        best: np.ndarray | None = None
        for packet in container.demux(stream):
            try:
                frames = packet.decode()
            except av.error.FFmpegError:
                continue
            for fr in frames:
                ft = float(fr.pts * tb) - start_offset_s if fr.pts is not None and tb else (float(fr.time) if fr.time is not None else 0.0)
                best = fr.to_ndarray(format="bgr24")
                if ft >= t - 1e-6:
                    return apply_rotation(best, rotation)
        return apply_rotation(best, rotation) if best is not None else None
    except av.error.FFmpegError:
        return None
    finally:
        container.close()
