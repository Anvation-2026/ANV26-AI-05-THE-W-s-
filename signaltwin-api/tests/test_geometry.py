"""Drawing validation and calibration."""

from __future__ import annotations

import copy
import math

import pytest
from pydantic import ValidationError

from signaltwin_api import errors
from signaltwin_api.models.contracts import Calibration, Geometry, JunctionConfig
from signaltwin_api.perception.geometry import build_homography, point_in_polygon, validate_geometry, validate_junction
from signaltwin_api.testing import synth

BASE = synth.junction_json()


def junction(**over) -> JunctionConfig:
    d = copy.deepcopy(BASE)
    d.update(over)
    return JunctionConfig.model_validate(d)


def cal(points, distances) -> Calibration:
    return Calibration.model_validate({"points": [{"x": x, "y": y} for x, y in points], "distances": distances})


RECT = [(580, 330), (700, 330), (700, 390), (580, 390)]


def test_homography_maps_pixels_to_metres() -> None:
    hg = build_homography(cal(RECT, [20, 10, 20, 10]))
    assert hg.to_world(580, 330) == pytest.approx((0, 0), abs=1e-6)
    assert hg.to_world(700, 390) == pytest.approx((20, 10), abs=1e-6)
    a, b = hg.to_world(600, 350), hg.to_world(660, 350)
    assert math.dist(a, b) == pytest.approx(10.0, abs=1e-6)  # 60 px at 6 px per metre


def test_homography_handles_perspective() -> None:
    # a trapezoid like a road seen from a bridge: the far edge is shorter in pixels than the near edge
    hg = build_homography(cal([(500, 300), (700, 300), (800, 500), (400, 500)], [10, 20, 10, 20]))
    far = math.dist(hg.to_world(500, 300), hg.to_world(700, 300))
    near = math.dist(hg.to_world(400, 500), hg.to_world(800, 500))
    assert far == pytest.approx(10, rel=1e-6) and near == pytest.approx(10, rel=1e-6)


@pytest.mark.parametrize(
    "points,distances,needle",
    [
        (RECT, [20, 10, 0, 10], "greater than zero"),
        (RECT, [20, 10, -3, 10], "greater than zero"),
        (RECT, [20, 10, 30, 10], "differ by more than"),
        ([(0, 0), (0, 0), (10, 10), (0, 10)], [1, 1, 1, 1], "same place"),
        ([(0, 0), (10, 0), (20, 0), (30, 0)], [1, 1, 1, 1], "straight line"),
        ([(0, 0), (100, 100), (100, 0), (0, 100)], [10, 10, 10, 10], "cross over"),
    ],
)
def test_bad_calibrations_say_why(points, distances, needle) -> None:
    with pytest.raises(errors.ApiError) as e:
        build_homography(cal(points, distances))
    assert e.value.code == "calibration_invalid" and needle in e.value.detail and "Setup" in e.value.fix


def test_complete_drawing_is_accepted_and_directions_point_into_the_junction() -> None:
    aps = validate_geometry(junction().geometry, 1280, 720)
    assert [a.name for a in aps] == ["N", "S", "E", "W"]
    dirs = {a.name: (round(a.inbound[0]), round(a.inbound[1])) for a in aps}
    assert dirs == {"N": (0, 1), "S": (0, -1), "E": (-1, 0), "W": (1, 0)}
    assert all(a.inbound_source == "lines" for a in aps)


def test_two_approaches_are_enough_and_one_is_not() -> None:
    d = copy.deepcopy(BASE)
    for k in ("stopLines", "upstreamLines", "queueZones"):
        d["geometry"][k] = {a: v for a, v in d["geometry"][k].items() if a in ("N", "S")}
    assert [a.name for a in validate_geometry(JunctionConfig.model_validate(d).geometry, 1280, 720)] == ["N", "S"]
    for k in ("stopLines", "upstreamLines", "queueZones"):
        d["geometry"][k] = {a: v for a, v in d["geometry"][k].items() if a == "N"}
    with pytest.raises(errors.ApiError) as e:
        validate_geometry(JunctionConfig.model_validate(d).geometry, 1280, 720)
    assert e.value.code == "geometry_incomplete"


def test_missing_shapes_are_named() -> None:
    d = copy.deepcopy(BASE)
    for a in ("E", "S", "W"):
        del d["geometry"]["stopLines"][a]
    with pytest.raises(errors.ApiError) as e:
        validate_geometry(JunctionConfig.model_validate(d).geometry, 1280, 720)
    assert "E stop line" in e.value.detail and "S stop line" in e.value.detail and "Setup" in e.value.fix


def test_partly_drawn_approaches_are_left_out_with_a_note() -> None:
    from signaltwin_api.perception.geometry import geometry_notes

    d = copy.deepcopy(BASE)
    del d["geometry"]["stopLines"]["E"]
    del d["geometry"]["upstreamLines"]["W"]
    del d["geometry"]["queueZones"]["S"]
    g = JunctionConfig.model_validate(d).geometry
    assert [a.name for a in validate_geometry(g, 1280, 720)] == ["N", "S", "W"]
    notes = " ".join(geometry_notes(g))
    assert "E has no stop line" in notes and "W has no upstream line" in notes and "S has no queue zone" in notes


def test_direction_falls_back_to_the_queue_zone_when_there_is_no_upstream_line() -> None:
    d = copy.deepcopy(BASE)
    d["geometry"]["upstreamLines"] = {}
    aps = validate_geometry(JunctionConfig.model_validate(d).geometry, 1280, 720)
    assert all(a.inbound_source == "zone" for a in aps) and (round(aps[0].inbound[0]), round(aps[0].inbound[1])) == (0, 1)


def test_degenerate_and_off_screen_shapes_are_refused() -> None:
    d = copy.deepcopy(BASE)
    d["geometry"]["stopLines"]["N"] = {"a": {"x": 100, "y": 100}, "b": {"x": 100.5, "y": 100}}
    with pytest.raises(errors.ApiError) as e:
        validate_junction(JunctionConfig.model_validate(d), 1280, 720)
    assert e.value.code == "junction_invalid" and "shorter than 2 pixels" in e.value.detail
    d = copy.deepcopy(BASE)
    d["geometry"]["stopLines"]["N"] = {"a": {"x": 99999, "y": 100}, "b": {"x": 100000, "y": 140}}
    with pytest.raises(errors.ApiError) as e:
        validate_junction(JunctionConfig.model_validate(d), 1280, 720)
    assert "outside the video" in e.value.detail
    d = copy.deepcopy(BASE)
    d["geometry"]["queueZones"]["N"] = [{"x": 1, "y": 1}, {"x": 2, "y": 2}, {"x": 3, "y": 3}]
    with pytest.raises(errors.ApiError) as e:
        validate_junction(JunctionConfig.model_validate(d), 1280, 720)
    assert "almost no area" in e.value.detail


def test_point_in_polygon() -> None:
    sq = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    assert point_in_polygon((5, 5), sq) and not point_in_polygon((11, 5), sq) and not point_in_polygon((-1, -1), sq)
    concave = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (5.0, 2.0), (0.0, 10.0)]
    assert point_in_polygon((1, 1), concave) and not point_in_polygon((5, 8), concave)


def test_geometry_model_accepts_front_end_shapes() -> None:
    g = Geometry.model_validate({"stopLines": {"N": {"a": {"x": 1, "y": 2}, "b": {"x": 3, "y": 4}}}, "upstreamLines": {}, "queueZones": {}})
    assert g.stopLines["N"].a.x == 1
    with pytest.raises(ValidationError):
        Geometry.model_validate({"stopLines": {"Q": {"a": {"x": 1, "y": 2}, "b": {"x": 3, "y": 4}}}})
