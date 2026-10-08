"""Pydantic mirror of src/contracts/index.ts in the front end.

Field names are camelCase on purpose so the JSON is identical on both sides.
Inputs ignore unknown fields (the front end may add some). Outputs are validated
against these models before they are sent, so the front end can rely on them.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Approach = Literal["N", "S", "E", "W"]
APPROACHES: tuple[Approach, ...] = ("N", "S", "E", "W")
VehicleClass = Literal["twoWheeler", "car", "autoRickshaw", "bus", "truck"]
VEHICLE_CLASSES: tuple[VehicleClass, ...] = ("twoWheeler", "car", "autoRickshaw", "bus", "truck")
ControllerKind = Literal["observed", "webster", "vac", "signaltwin"]
RuleKind = Literal[
    "stay", "switch", "mingreen", "maxgreen", "fairness", "emergency", "clearance", "extend", "gapout", "fixed"
]


class _In(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


# --------------------------------------------------------------------------- parameters


class ClassSpec(_In):
    label: str
    tag: str
    pcu: float = Field(gt=0)
    people: float = Field(gt=0)


def default_classes() -> dict[VehicleClass, ClassSpec]:
    return {
        "twoWheeler": ClassSpec(label="Two-wheeler", tag="T", pcu=0.5, people=1.3),
        "car": ClassSpec(label="Car", tag="C", pcu=1.0, people=1.5),
        "autoRickshaw": ClassSpec(label="Auto-rickshaw", tag="A", pcu=1.0, people=2.0),
        "bus": ClassSpec(label="Bus", tag="B", pcu=2.75, people=30.0),
        "truck": ClassSpec(label="Truck", tag="K", pcu=2.75, people=1.2),
    }


class Params(_In):
    classes: dict[VehicleClass, ClassSpec] = Field(default_factory=default_classes)
    satFlowPerLane: float = Field(1800.0, gt=0)
    lanes: int = Field(2, ge=1, le=8)
    startupLost: float = Field(2.0, ge=0)
    yellow: float = Field(3.0, ge=0)
    allRed: float = Field(2.0, ge=0)
    minGreen: float = Field(10.0, gt=0)
    maxGreen: float = Field(50.0, gt=0)
    fairnessCap: float = Field(60.0, gt=0)
    travelMin: float = Field(8.0, gt=0)
    travelMax: float = Field(12.0, gt=0)
    binSeconds: float = Field(15.0, gt=0)
    smoothing: float = Field(0.35, gt=0, le=1)
    seeds: int = Field(20, ge=1, le=200)
    horizon: int = Field(1800, ge=60, le=43200)
    fourPhase: bool = False
    beta: float = 1.5
    gamma: float = 0.5
    lookaheadH: float = 9.0
    hysteresis: float = 0.6
    vacGap: float = 3.0

    @field_validator("classes")
    @classmethod
    def _all_classes(cls, v: dict[VehicleClass, ClassSpec]) -> dict[VehicleClass, ClassSpec]:
        merged = default_classes()
        merged.update(v)
        return merged


class ControllerOptions(_In):
    objective: Literal["vehicles", "people"] = "vehicles"
    lookahead: bool = True
    fairnessGuard: bool = True
    pcuWeighting: bool = True
    hysteresisOn: bool = True
    emergencyPriority: bool = True
    queueClearance: bool = True


class NoiseSpec(_In):
    missRate: float = Field(0.0, ge=0, le=1)
    labelError: float = Field(0.0, ge=0, le=1)
    delaySec: float = Field(0.0, ge=0)


# --------------------------------------------------------------------------- junction


class Point(_In):
    x: float
    y: float


class Line(_In):
    a: Point
    b: Point


class Geometry(_In):
    stopLines: dict[Approach, Line] = Field(default_factory=dict)
    upstreamLines: dict[Approach, Line] = Field(default_factory=dict)
    queueZones: dict[Approach, list[Point]] = Field(default_factory=dict)


class Calibration(_In):
    points: list[Point] = Field(min_length=4, max_length=4)
    distances: list[float] = Field(min_length=4, max_length=4)


class ObservedTiming(_In):
    greens: list[float] = Field(default_factory=lambda: [38.0, 30.0])
    yellow: float = 3.0
    allRed: float = 2.0
    fourPhase: bool = False


class VideoSize(_In):
    w: float
    h: float
    duration: float


class JunctionConfig(_In):
    id: str = "junction"
    name: str = Field("Junction", min_length=1, max_length=120)
    source: Literal["sample", "video", "counts"] = "video"
    videoName: str | None = None
    videoSize: VideoSize | None = None
    countsRows: int | None = None
    geometry: Geometry = Field(default_factory=Geometry)
    calibration: Calibration | None = None
    observed: ObservedTiming = Field(default_factory=ObservedTiming)
    updatedAt: str = ""


# --------------------------------------------------------------------------- perception


class Detection(_In):
    id: int
    cls: VehicleClass
    x: float
    y: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)
    conf: float = Field(ge=0, le=1)


class PerceptionFrame(_In):
    t: float = Field(ge=0)
    detections: list[Detection]


class CountEvent(_In):
    t: float = Field(ge=0)
    approach: Approach
    cls: VehicleClass
    line: Literal["upstream", "stop"]


class ModelInfo(_In):
    name: str
    version: str
    sha256: str
    device: str


class PerceptionMeta(_In):
    videoId: str
    sha256: str
    durationS: float
    sourceFps: float
    processedFps: float
    stride: int
    width: int
    height: int
    frameCount: int
    model: ModelInfo
    startedAt: str
    finishedAt: str
    processingS: float
    warnings: list[str] = Field(default_factory=list)


class PerceptionQueue(_In):
    binS: int = 1
    approaches: dict[Approach, list[float]]
    counts: dict[Approach, list[int]]


class SpeedSample(_In):
    t: float
    approach: Approach
    cls: VehicleClass
    kmh: float


class Departure(_In):
    t: float
    approach: Approach
    cls: VehicleClass
    pcu: float
    sat: bool


class SatFlow(_In):
    perLane: float
    startupLost: float
    headways: list[float]
    samples: int
    isDefault: bool
    startupLostIsDefault: bool | None = None


class Quality(_In):
    meanConfidence: float
    trackFragmentation: float
    lowLight: bool
    cameraMotionPx: float
    missedCountRisk: Literal["low", "medium", "high"]
    warnings: list[str] = Field(default_factory=list)


class PerceptionResult(_In):
    fps: float = Field(gt=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    frames: list[PerceptionFrame]
    counts: list[CountEvent] | None = None
    meta: PerceptionMeta | None = None
    queue: PerceptionQueue | None = None
    speeds: list[SpeedSample] | None = None
    departures: list[Departure] | None = None
    waits: list[float] | None = None
    satFlow: SatFlow | None = None
    quality: Quality | None = None


# --------------------------------------------------------------------------- demand


class CountsRow(_In):
    t: float = Field(ge=0)
    approach: Approach
    cls: VehicleClass
    count: float = Field(ge=0)


class DemandProfile(_In):
    binSeconds: float
    duration: float
    rates: list[list[float]]
    mix: list[dict[VehicleClass, float]]
    satFlowMeasured: float | None = None
    satFlowIsDefault: bool | None = None
    startupLostMeasured: float | None = None


class PerceptionSource(_In):
    kind: Literal["perception"]
    result: PerceptionResult


class CountsSource(_In):
    kind: Literal["counts"]
    rows: list[CountsRow]


EstimateSource = Annotated[PerceptionSource | CountsSource, Field(discriminator="kind")]


class DemandEstimateRequest(_In):
    source: EstimateSource
    junction: JunctionConfig | None = None
    params: Params = Field(default_factory=Params)
    smoothing: float | None = Field(None, gt=0, le=1)
    binSeconds: float | None = Field(None, gt=0)


class SatFlowOut(_In):
    perLane: float
    startupLost: float
    headways: list[float]
    samples: int
    isDefault: bool


class DemandEstimate(_In):
    profile: DemandProfile
    rawPcu: list[list[float]]
    smoothPcu: list[list[float]]
    totals: list[float]
    satFlow: SatFlowOut
    source: Literal["sample", "counts", "perception"]
    binSeconds: float
    warnings: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- jobs


class PerceptionOptions(_In):
    stride: int | Literal["auto"] = "auto"
    maxProcessedFps: float = Field(10.0, ge=1, le=60)
    model: str | None = None
    confidence: float | None = Field(None, ge=0.01, le=0.99)
    frameSampleS: float = Field(0.2, ge=0.04, le=5.0)
    stabilise: bool = True  # follow a moving camera so the lines stay on the road
    startS: float = Field(0.0, ge=0)
    endS: float | None = Field(None, gt=0)


class PerceptionJobRequest(_In):
    videoId: str
    junction: JunctionConfig
    params: Params = Field(default_factory=Params)
    options: PerceptionOptions = Field(default_factory=PerceptionOptions)


# --------------------------------------------------------------------------- simulation


class Scenario(_In):
    id: Literal["A", "B", "custom"]
    name: str
    description: str = ""
    targetY: float
    multipliers: list[float]
    surges: list[dict[str, float]] = Field(default_factory=list)


class EmergencyEvent(_In):
    t: float
    approach: int


class RunSetup(_In):
    """What an experiment needs to build a simulation. Mirrors RunSetup in src/engine/experiment.ts."""

    params: Params
    options: ControllerOptions = Field(default_factory=ControllerOptions)
    baseDemand: DemandProfile
    scenario: Scenario
    observed: ObservedTiming
    noise: NoiseSpec | None = None
    emergencies: list[EmergencyEvent] | None = None


class CompareRequest(_In):
    type: Literal["compare"]
    setup: RunSetup
    kinds: list[ControllerKind] = Field(min_length=1, max_length=4)
    seeds: int = Field(ge=1, le=200)


class AblationRequest(_In):
    type: Literal["ablation"]
    setup: RunSetup
    seeds: int = Field(ge=1, le=200)


class NoiseRequest(_In):
    type: Literal["noise"]
    setup: RunSetup
    levels: list[float] = Field(min_length=1, max_length=12)
    seeds: int = Field(ge=1, le=200)


class GridRequest(_In):
    type: Literal["grid"]
    setup: RunSetup
    seeds: int = Field(ge=1, le=100)
    betas: list[float] = Field(min_length=1, max_length=12)
    gammas: list[float] = Field(min_length=1, max_length=12)


ExperimentRequest = Annotated[CompareRequest | AblationRequest | NoiseRequest | GridRequest, Field(discriminator="type")]


class SimRequest(_In):
    params: Params
    options: ControllerOptions = Field(default_factory=ControllerOptions)
    baseDemand: DemandProfile
    scenario: Scenario
    observed: ObservedTiming
    noise: NoiseSpec | None = None
    emergencies: list[EmergencyEvent] | None = None
    controller: ControllerKind
    seed: int
