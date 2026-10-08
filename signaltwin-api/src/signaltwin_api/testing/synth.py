"""A synthetic four-way junction seen from above, with exact ground truth.

It exists so the counting, queue, speed and saturation logic can be tested against numbers that are known,
which a real clip cannot give. It tests the logic, not how well a model finds vehicles in real footage.

World: 1280 x 720 pixels, 6 pixels per metre, left-hand traffic, one inbound lane per approach, two-phase fixed
signal (N and S together, then E and W together). Vehicles follow the Intelligent Driver Model and stop for red.
Vehicles are painted as plain rectangles in one colour per class so SyntheticDetector can find them from pixels.
The truth is computed from the same boxes the video shows, with its own code (not the pipeline's).
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any, cast

import numpy as np

from ..perception.detector import SYNTH_COLOURS

PX_PER_M = 6.0
W, H = 1280, 720
CX, CY = 640, 360
STOP_M = 15.0  # stop line, metres from the junction centre
UP_M = 30.0  # upstream line, metres before the stop line
ZONE_M = 38.0  # queue zone, metres before the stop line
LANE_M = 3.0  # centre of the inbound lane from the road centreline
APS = ("N", "S", "E", "W")

# length m, width m
VTYPES: dict[str, tuple[float, float]] = {
    "twoWheeler": (2.2, 1.0),
    "car": (4.2, 1.8),
    "autoRickshaw": (2.8, 1.4),
    "bus": (11.0, 2.5),
    "truck": (8.0, 2.4),
}
PCU = {"twoWheeler": 0.5, "car": 1.0, "autoRickshaw": 1.0, "bus": 2.75, "truck": 2.75}


@dataclass
class SynthConfig:
    seconds: float = 300.0
    seed: int = 7
    fps: int = 25
    rates: tuple[float, float, float, float] = (0.10, 0.09, 0.12, 0.08)  # vehicles per second per approach
    mix: dict[str, float] = field(default_factory=lambda: {"car": 0.6, "twoWheeler": 0.25, "autoRickshaw": 0.05, "bus": 0.05, "truck": 0.05})
    green: tuple[float, float] = (30.0, 30.0)
    yellow: float = 3.0
    all_red: float = 2.0
    start_in_cycle: float = 40.0  # seconds into the cycle at t=0 (so N and S start on red and a queue forms)
    jitter_free: bool = True


def pt(ap: int, p: float, lat: float) -> tuple[float, float]:
    """Pixel for p metres along approach ap from its stop line (negative = before it) and lat metres sideways."""
    if ap == 0:
        return (CX + PX_PER_M * lat, CY - STOP_M * PX_PER_M + PX_PER_M * p)
    if ap == 1:
        return (CX - PX_PER_M * lat, CY + STOP_M * PX_PER_M - PX_PER_M * p)
    if ap == 2:
        return (CX + STOP_M * PX_PER_M - PX_PER_M * p, CY + PX_PER_M * lat)
    return (CX - STOP_M * PX_PER_M + PX_PER_M * p, CY - PX_PER_M * lat)


def junction_json() -> dict[str, Any]:
    stop, up, zone = {}, {}, {}
    for i, a in enumerate(APS):
        a0, a1 = pt(i, 0, 0), pt(i, 0, 6)
        stop[a] = {"a": {"x": a0[0], "y": a0[1]}, "b": {"x": a1[0], "y": a1[1]}}
        u0, u1 = pt(i, -UP_M, 0), pt(i, -UP_M, 6)
        up[a] = {"a": {"x": u0[0], "y": u0[1]}, "b": {"x": u1[0], "y": u1[1]}}
        z = [pt(i, -ZONE_M, 0.3), pt(i, -ZONE_M, 5.7), pt(i, 0.5, 5.7), pt(i, 0.5, 0.3)]
        zone[a] = [{"x": x, "y": y} for x, y in z]
    return {
        "id": "synthetic",
        "name": "Synthetic four-way",
        "source": "video",
        "videoName": "synthetic-junction.mp4",
        "videoSize": {"w": W, "h": H, "duration": 120},
        "geometry": {"stopLines": stop, "upstreamLines": up, "queueZones": zone},
        "calibration": {
            "points": [{"x": 580, "y": 330}, {"x": 700, "y": 330}, {"x": 700, "y": 390}, {"x": 580, "y": 390}],
            "distances": [20, 10, 20, 10],
        },
        "observed": {"greens": [30, 30], "yellow": 3, "allRed": 2, "fourPhase": False},
        "updatedAt": "2026-01-01T00:00:00Z",
    }


def box_for(ap: int, p_front: float, cls: str) -> tuple[float, float, float, float]:
    length, width = VTYPES[cls]
    hw = width * PX_PER_M / 2
    L = length * PX_PER_M
    fx, fy = pt(ap, p_front, LANE_M)
    if ap == 0:
        return (fx - hw, fy - L, fx + hw, fy)
    if ap == 1:
        return (fx - hw, fy, fx + hw, fy + L)
    if ap == 2:
        return (fx, fy - hw, fx + L, fy + hw)
    return (fx - L, fy - hw, fx, fy + hw)


def along_of(ap: int, bx: float, by: float) -> float:
    """Metres past the stop line of a bottom-centre point, in the approach's direction of travel."""
    if ap == 0:
        return (by - (CY - STOP_M * PX_PER_M)) / PX_PER_M
    if ap == 1:
        return ((CY + STOP_M * PX_PER_M) - by) / PX_PER_M
    if ap == 2:
        return ((CX + STOP_M * PX_PER_M) - bx) / PX_PER_M
    return (bx - (CX - STOP_M * PX_PER_M)) / PX_PER_M


def in_zone(ap: int, bx: float, by: float) -> bool:
    q = along_of(ap, bx, by)
    if not (-ZONE_M <= q <= 0.5):
        return False
    # lateral check using the polygon's two long edges
    x0, y0 = pt(ap, 0, 0.3)
    x1, y1 = pt(ap, 0, 5.7)
    ux, uy = x1 - x0, y1 - y0
    n2 = ux * ux + uy * uy
    f = ((bx - x0) * ux + (by - y0) * uy) / n2
    return 0.0 <= f <= 1.0


@dataclass
class Veh:
    id: int
    ap: int
    cls: str
    p: float  # front position, metres past the stop line
    v: float
    v0: float
    a: float
    T: float
    L: float
    # truth bookkeeping
    prev_q: float | None = None
    stat_since: float | None = None
    queued_ap: int = -1
    wait_start: float | None = None
    up_done: bool = False
    stop_done: bool = False


def lamp(cfg: SynthConfig, t: float) -> list[str]:
    """Lamp colour of each approach at time t: 'G', 'Y' or 'R'."""
    g0, g1 = cfg.green
    cycle = g0 + g1 + 2 * (cfg.yellow + cfg.all_red)
    x = (t + cfg.start_in_cycle) % cycle
    seg = [("G0", g0), ("Y0", cfg.yellow), ("A0", cfg.all_red), ("G1", g1), ("Y1", cfg.yellow), ("A1", cfg.all_red)]
    name = "A0"
    for n, d in seg:
        if x < d:
            name = n
            break
        x -= d
    ns = "G" if name == "G0" else "Y" if name == "Y0" else "R"
    ew = "G" if name == "G1" else "Y" if name == "Y1" else "R"
    return [ns, ns, ew, ew]


def green_starts(cfg: SynthConfig) -> list[tuple[float, int]]:
    """True moments each phase turned green during the clip."""
    g0, g1 = cfg.green
    cycle = g0 + g1 + 2 * (cfg.yellow + cfg.all_red)
    offsets = [(0.0, 0), (g0 + cfg.yellow + cfg.all_red, 1)]
    out: list[tuple[float, int]] = []
    k = -2
    while True:
        done = True
        for off, ph in offsets:
            t = k * cycle + off - cfg.start_in_cycle
            if t > cfg.seconds:
                continue
            done = False
            if t >= 0:
                out.append((t, ph))
        if done and k > 0:
            break
        k += 1
        if k > 10_000:
            break
    return sorted(out)


@dataclass
class GroundTruth:
    config: dict[str, Any]
    junction: dict[str, Any]
    frames: list[list[dict[str, Any]]]  # per frame: id, cls, box (x1,y1,x2,y2)
    counts: list[dict[str, Any]]  # t, approach, cls, line
    departures: list[dict[str, Any]]  # t, approach, cls, pcu, sat, kmh
    waits: list[dict[str, Any]]  # approach, seconds
    queue_veh: dict[str, list[int]]
    queue_pcu: dict[str, list[float]]
    green_starts: list[tuple[float, int]]
    vehicles_spawned: int

    def to_json(self) -> str:
        return json.dumps(self.__dict__, separators=(",", ":"))

    def totals(self) -> dict[str, dict[str, dict[str, int]]]:
        """counts[line][approach][cls]"""
        t: dict[str, dict[str, dict[str, int]]] = {"upstream": {}, "stop": {}}
        for c in self.counts:
            t[c["line"]].setdefault(c["approach"], {}).setdefault(c["cls"], 0)
            t[c["line"]][c["approach"]][c["cls"]] += 1
        return t


def simulate(cfg: SynthConfig) -> GroundTruth:
    rng = random.Random(cfg.seed)
    dt = 1.0 / cfg.fps
    steps = int(round(cfg.seconds * cfg.fps))
    cls_names = list(cfg.mix.keys())
    cls_w = [cfg.mix[c] for c in cls_names]
    lanes: list[list[Veh]] = [[], [], [], []]
    next_arrival = [rng.expovariate(r) if r > 0 else math.inf for r in cfg.rates]
    nid = 0
    frames: list[list[dict[str, Any]]] = []
    counts: list[dict[str, Any]] = []
    deps: list[dict[str, Any]] = []
    waits: list[dict[str, Any]] = []
    bins = int(math.ceil(cfg.seconds)) + 1
    qveh = {a: [0] * bins for a in APS}
    qpcu = {a: [0.0] * bins for a in APS}
    spawn_dist = (44.0, 44.0, 85.0, 85.0)
    s0, b_comf = 2.0, 2.0

    for step in range(steps):
        t = step * dt
        lamps = lamp(cfg, t)
        # spawn
        for ap in range(4):
            if t >= next_arrival[ap]:
                cls = rng.choices(cls_names, weights=cls_w)[0]
                length, _ = VTYPES[cls]
                p0 = -spawn_dist[ap] + length
                lane = lanes[ap]
                free = (not lane) or (lane[-1].p - lane[-1].L - s0 - 1.0 >= p0)
                if free:
                    v0 = rng.uniform(11.0, 14.0) if cls != "bus" else rng.uniform(9.0, 11.0)
                    a = rng.uniform(1.3, 2.0) if cls in ("car", "twoWheeler", "autoRickshaw") else rng.uniform(0.8, 1.2)
                    T = rng.uniform(0.9, 1.3)
                    gap0 = float("inf") if not lane else lane[-1].p - lane[-1].L - p0
                    v_start = min(v0 * 0.9, max(0.0, gap0 / 2.0)) if lane else v0 * 0.9
                    lane.append(Veh(nid, ap, cls, p0, v_start, v0, a, T, length))
                    nid += 1
                    next_arrival[ap] = t + rng.expovariate(cfg.rates[ap])
                else:
                    next_arrival[ap] = t + 0.2
        # move (IDM)
        for ap in range(4):
            lane = lanes[ap]
            for i, veh in enumerate(lane):
                gap: float
                dv: float
                if i > 0:
                    lead = lane[i - 1]
                    gap = lead.p - lead.L - veh.p
                    dv = veh.v - lead.v
                else:
                    gap, dv = float("inf"), 0.0
                if veh.p < 0:
                    must_stop = lamps[ap] == "R" or (lamps[ap] == "Y" and -veh.p >= veh.v * veh.v / (2 * 3.5) + 1.0)
                    if must_stop:
                        g_line = -veh.p
                        if g_line < gap:
                            gap, dv = g_line, veh.v
                gap = max(gap, 0.1)
                if math.isinf(gap):
                    acc = veh.a * (1 - (veh.v / veh.v0) ** 4)
                else:
                    s_star = s0 + veh.v * veh.T + veh.v * dv / (2 * math.sqrt(veh.a * b_comf))
                    acc = veh.a * (1 - (veh.v / veh.v0) ** 4 - (max(s_star, 0.0) / gap) ** 2)
                acc = max(acc, -8.0)
                veh.v = max(0.0, veh.v + acc * dt)
                veh.p += veh.v * dt
        # frame boxes and truth
        fr: list[dict[str, Any]] = []
        for ap in range(4):
            lane = lanes[ap]
            for veh in lane:
                x1, y1, x2, y2 = box_for(ap, veh.p, veh.cls)
                fr.append({"id": veh.id, "cls": veh.cls, "box": [x1, y1, x2, y2]})
                bx, by = (x1 + x2) / 2.0, y2
                q = along_of(ap, bx, by)
                if veh.prev_q is not None:
                    for name, lineq in (("upstream", -UP_M), ("stop", 0.0)):
                        if name == "upstream" and veh.up_done:
                            continue
                        if name == "stop" and veh.stop_done:
                            continue
                        if veh.prev_q < lineq <= q:
                            frac = (lineq - veh.prev_q) / (q - veh.prev_q)
                            tc = (t - dt) + frac * dt
                            counts.append({"t": tc, "approach": APS[ap], "cls": veh.cls, "line": name})
                            if name == "upstream":
                                veh.up_done = True
                            else:
                                veh.stop_done = True
                                sat = any(o is not veh and in_zone(ap, (o_b[0] + o_b[2]) / 2, o_b[3]) for o in lane for o_b in [box_for(ap, o.p, o.cls)])
                                deps.append(
                                    {"t": tc, "approach": APS[ap], "cls": veh.cls, "pcu": PCU[veh.cls], "sat": sat, "kmh": veh.v * 3.6}
                                )
                                if veh.wait_start is not None and veh.queued_ap == ap:
                                    waits.append({"approach": APS[ap], "seconds": tc - veh.wait_start})
                veh.prev_q = q
                # stationary and queued state, from the true speed
                if veh.v < 1.0:
                    if veh.stat_since is None:
                        veh.stat_since = t
                elif veh.v >= 1.5:
                    veh.stat_since = None
                if in_zone(ap, bx, by) and veh.stat_since is not None and t - veh.stat_since > 2.0 and veh.queued_ap < 0:
                    veh.queued_ap = ap
                    veh.wait_start = veh.stat_since
            lane[:] = [v for v in lane if v.p - v.L < 60.0]
        frames.append(fr)
        # queue sample: the last step of each second
        b = int(math.floor(t))
        for ap in range(4):
            n, pc = 0, 0.0
            for veh in lanes[ap]:
                x1, y1, x2, y2 = box_for(ap, veh.p, veh.cls)
                if veh.stat_since is not None and t - veh.stat_since > 2.0 and in_zone(ap, (x1 + x2) / 2, y2):
                    n += 1
                    pc += PCU[veh.cls]
            qveh[APS[ap]][b] = n
            qpcu[APS[ap]][b] = pc
    counts.sort(key=lambda c: (c["t"], c["approach"]))
    deps.sort(key=lambda d: (d["t"], d["approach"]))
    return GroundTruth(
        config={"seconds": cfg.seconds, "seed": cfg.seed, "fps": cfg.fps, "rates": list(cfg.rates), "mix": cfg.mix},
        junction=junction_json(),
        frames=frames,
        counts=counts,
        departures=deps,
        waits=waits,
        queue_veh=qveh,
        queue_pcu=qpcu,
        green_starts=green_starts(cfg),
        vehicles_spawned=nid,
    )


# --------------------------------------------------------------------------- video


def _background() -> np.ndarray:
    import cv2

    img = np.full((H, W, 3), (120, 128, 118), dtype=np.uint8)
    road = (172, 172, 172)
    cv2.rectangle(img, (0, CY - 6 * 6), (W, CY + 6 * 6), road, -1)
    cv2.rectangle(img, (CX - 6 * 6, 0), (CX + 6 * 6, H), road, -1)
    for ap in range(4):
        a, b = pt(ap, 0, -6), pt(ap, 0, 6)
        cv2.line(img, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), (250, 250, 250), 2)
    cv2.line(img, (0, CY), (W, CY), (190, 190, 150), 1)
    cv2.line(img, (CX, 0), (CX, H), (190, 190, 150), 1)
    return img


def write_video(
    truth: GroundTruth, path: Path, *, noise_sigma: float = 0.0, codec: str = "libx264", crf: int = 12, brightness: float = 1.0, drop_every: int = 0, blank: bool = False
) -> str:
    """Render the truth to a video file with PyAV. Returns the codec actually used.

    `drop_every` leaves out every n-th frame but keeps the timeline, which makes a variable-frame-rate file.
    `blank` paints an empty road (no vehicles).
    """
    import av

    fps = int(truth.config["fps"])
    bg = _background()
    container = av.open(str(path), mode="w")
    used = codec
    try:
        try:
            stream = cast(Any, container.add_stream(codec, rate=fps))
            stream.options = {"crf": str(crf), "preset": "veryfast"}
        except Exception:  # noqa: BLE001 - libx264 may be missing in some PyAV builds
            used = "mpeg4"
            stream = cast(Any, container.add_stream("mpeg4", rate=fps))
            stream.bit_rate = 6_000_000
        stream.width, stream.height, stream.pix_fmt = W, H, "yuv420p"
        rng = np.random.default_rng(3)
        import cv2

        for index, fr in enumerate(truth.frames):
            if drop_every and index % drop_every == drop_every - 1:
                continue
            img = bg.copy()
            for v in [] if blank else fr:
                x1, y1, x2, y2 = v["box"]
                cv2.rectangle(img, (int(round(x1)), int(round(y1))), (int(round(x2)) - 1, int(round(y2)) - 1), SYNTH_COLOURS[v["cls"]], -1)
            if brightness != 1.0:
                img = np.clip(img.astype(np.float32) * brightness, 0, 255).astype(np.uint8)
            if noise_sigma > 0:
                img = np.clip(img.astype(np.float32) + rng.normal(0, noise_sigma, img.shape), 0, 255).astype(np.uint8)
            frame = av.VideoFrame.from_ndarray(img, format="bgr24")
            if drop_every:
                frame.pts = index
                frame.time_base = Fraction(1, fps)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    finally:
        container.close()
    return used


def make(path: Path, cfg: SynthConfig | None = None, **video_kw: Any) -> GroundTruth:
    cfg = cfg or SynthConfig()
    truth = simulate(cfg)
    write_video(truth, path, **video_kw)
    return truth


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Make a synthetic junction video with exact ground truth.")
    ap.add_argument("out", type=Path, help="video file to write (.mp4)")
    ap.add_argument("--seconds", type=float, default=300.0)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--junction", type=Path, help="also write the matching junction JSON (import it in Setup)")
    ap.add_argument("--truth", type=Path, help="also write the ground-truth totals as JSON")
    ap.add_argument("--noise", type=float, default=0.0, help="Gaussian pixel noise (sigma)")
    ap.add_argument("--brightness", type=float, default=1.0)
    a = ap.parse_args(argv)
    cfg = SynthConfig(seconds=a.seconds, seed=a.seed)
    truth = simulate(cfg)
    codec = write_video(truth, a.out, noise_sigma=a.noise, brightness=a.brightness)
    if a.junction:
        j = junction_json()
        j["videoSize"]["duration"] = a.seconds
        a.junction.write_text(json.dumps(j, indent=2), encoding="utf-8")
    if a.truth:
        totals = truth.totals()
        a.truth.write_text(json.dumps({"seconds": a.seconds, "seed": a.seed, "spawned": truth.vehicles_spawned, "counts": totals, "waits": len(truth.waits)}, indent=2), encoding="utf-8")
    print(f"wrote {a.out} ({codec}, {a.seconds:g} s, {truth.vehicles_spawned} vehicles)")


if __name__ == "__main__":
    main()
