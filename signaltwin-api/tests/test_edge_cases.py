"""Awkward real-world inputs: damaged files, variable frame rate, rotation, empty roads, dropped connections."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from signaltwin_api.config import Settings
from signaltwin_api.models.contracts import JunctionConfig, Params, PerceptionOptions
from signaltwin_api.perception.detector import SyntheticDetector
from signaltwin_api.perception.pipeline import run_perception
from signaltwin_api.testing import synth
from signaltwin_api.video.decode import DecodeStats, apply_rotation, iter_frames
from signaltwin_api.video.probe import _rotation_of, probe

SETTINGS = Settings(_env_file=None)  # type: ignore[call-arg]


def analyse(path: Path, truth: synth.GroundTruth, **kw: object):  # type: ignore[no-untyped-def]
    info = probe(path, SETTINGS)
    return run_perception(path, "v_t", "0" * 64, info, JunctionConfig.model_validate(truth.junction), Params(lanes=1), PerceptionOptions(**kw), SyntheticDetector(), SETTINGS)  # type: ignore[arg-type]


@pytest.fixture(scope="module")
def truth60() -> synth.GroundTruth:
    return synth.simulate(synth.SynthConfig(seconds=60, seed=5))


def totals(res) -> Counter:  # type: ignore[no-untyped-def]
    return Counter(c.line for c in (res.counts or []))


def test_damaged_packets_in_the_middle_are_skipped_and_reported(tmp_path: Path, truth60: synth.GroundTruth) -> None:
    good = tmp_path / "good.mp4"
    synth.write_video(truth60, good)
    data = bytearray(good.read_bytes())
    mid = len(data) // 2
    data[mid : mid + 3000] = bytes(np.random.default_rng(1).integers(0, 255, 3000, dtype=np.uint8))
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(bytes(data))
    stats = DecodeStats()
    n = sum(1 for _ in iter_frames(bad, fps_hint=25, rotation=0, start_offset_s=0, target_fps=10, scale=1.0, stats=stats))
    assert n > 300  # most of the clip still decodes
    res = analyse(bad, truth60)
    assert res.meta and res.meta.frameCount > 300
    # the analysis finishes and counts most vehicles, instead of failing the whole job
    clean = totals(analyse(good, truth60))
    assert totals(res)["stop"] >= 0.6 * clean["stop"]


def test_variable_frame_rate_keeps_real_times(tmp_path: Path, truth60: synth.GroundTruth) -> None:
    path = tmp_path / "vfr.mp4"
    synth.write_video(truth60, path, drop_every=3)  # every third frame missing: 16.7 frames per second on average
    res = analyse(path, truth60)
    t_stop = sorted(c["t"] for c in truth60.counts if c["line"] == "stop")
    m_stop = sorted(c.t for c in (res.counts or []) if c.line == "stop")
    assert abs(len(t_stop) - len(m_stop)) <= 1
    # times come from the decoder's timestamps, not from frame numbers, so they agree with the truth
    assert np.median([abs(a - b) for a, b in zip(t_stop, m_stop, strict=False)]) < 0.35
    assert max(f.t for f in res.frames) == pytest.approx(60, abs=1.5)


def test_an_empty_road_gives_zero_counts_and_says_so(tmp_path: Path) -> None:
    truth = synth.simulate(synth.SynthConfig(seconds=150, seed=2))
    path = tmp_path / "blank.mp4"
    synth.write_video(truth, path, blank=True)
    res = analyse(path, truth)
    assert not res.counts and not res.departures
    q = res.quality
    assert q is not None
    assert any("Almost no vehicles were detected" in w for w in q.warnings) and q.missedCountRisk == "high"
    assert res.satFlow is not None and res.satFlow.isDefault and res.satFlow.startupLostIsDefault


def test_a_very_low_frame_rate_is_warned_about(tmp_path: Path) -> None:
    truth = synth.simulate(synth.SynthConfig(seconds=30, seed=2, fps=4))
    path = tmp_path / "slow.mp4"
    synth.write_video(truth, path)
    res = analyse(path, truth)
    assert any("frames per second" in w for w in (res.meta.warnings if res.meta else []))


def test_a_dark_clip_is_flagged(tmp_path: Path) -> None:
    truth = synth.simulate(synth.SynthConfig(seconds=20, seed=2))
    path = tmp_path / "dark.mp4"
    synth.write_video(truth, path, brightness=0.25)
    res = analyse(path, truth)
    assert res.quality and res.quality.lowLight and res.quality.missedCountRisk == "high"


def test_time_range_limits_the_work(tmp_path: Path, truth60: synth.GroundTruth) -> None:
    path = tmp_path / "t.mp4"
    synth.write_video(truth60, path)
    res = analyse(path, truth60, startS=20, endS=40)
    assert res.frames and min(f.t for f in res.frames) >= 19.5 and max(f.t for f in res.frames) <= 40.5
    assert all(19.5 <= c.t <= 40.5 for c in (res.counts or []))
    with pytest.raises(Exception, match="start time is not before the end time"):
        analyse(path, truth60, startS=50, endS=40)


def test_rotation_is_applied_and_read_from_metadata() -> None:
    img = np.zeros((4, 6, 3), np.uint8)
    img[0, 0] = (255, 0, 0)
    assert apply_rotation(img, 0).shape == (4, 6, 3)
    r90 = apply_rotation(img, 90)
    assert r90.shape == (6, 4, 3) and tuple(r90[0, 3]) == (255, 0, 0)  # the top-left pixel moves to the top-right, clockwise
    assert apply_rotation(img, 180).shape == (4, 6, 3) and tuple(apply_rotation(img, 180)[3, 5]) == (255, 0, 0)
    assert apply_rotation(img, 270).shape == (6, 4, 3)
    assert apply_rotation(img, 450).shape == (6, 4, 3)  # 450 is 90

    class S:
        metadata = {"rotate": "270"}

    assert _rotation_of(S()) == 270  # type: ignore[arg-type]

    class T:
        metadata: dict[str, str] = {}

    assert _rotation_of(T()) == 0  # type: ignore[arg-type]


def test_a_dropped_connection_mid_upload_leaves_nothing_behind(client: TestClient, video60) -> None:
    data = video60[0].read_bytes()

    def chunks():  # type: ignore[no-untyped-def]
        yield data[:200_000]
        raise RuntimeError("the connection dropped")

    with pytest.raises(Exception):  # noqa: B017 - the client library re-raises the broken stream
        client.post("/v1/videos", content=chunks(), headers={"X-Filename": "x.mp4"})
    st = client.app.state.ctx.storage
    assert not list(st.tmp_dir.glob("up_*")) and not list(st.videos_dir.glob("*"))
    ok = client.post("/v1/videos", content=data, headers={"Content-Type": "application/octet-stream", "X-Filename": "x.mp4"})
    assert ok.status_code == 201  # and the server is fine afterwards


def test_the_lines_can_be_drawn_in_any_direction(tmp_path: Path, truth60: synth.GroundTruth) -> None:
    """Swapping the two end points of every line must not change the counts."""
    path = tmp_path / "d.mp4"
    synth.write_video(truth60, path)
    flipped = JunctionConfig.model_validate(truth60.junction)
    for group in (flipped.geometry.stopLines, flipped.geometry.upstreamLines):
        for line in group.values():
            line.a, line.b = line.b, line.a
    info = probe(path, SETTINGS)
    a = run_perception(path, "v", "0" * 64, info, JunctionConfig.model_validate(truth60.junction), Params(lanes=1), PerceptionOptions(), SyntheticDetector(), SETTINGS)
    b = run_perception(path, "v", "0" * 64, info, flipped, Params(lanes=1), PerceptionOptions(), SyntheticDetector(), SETTINGS)
    assert totals(a) == totals(b)
