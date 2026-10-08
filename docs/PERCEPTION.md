# How the back end measures a junction

Every rule here has a test in `signaltwin-api/tests/test_analysis.py` against synthetic video with known truth, or against a hand-built track.

## Geometry

- All coordinates are pixels of the original video frame after rotation. Boxes and lines use the same space.
- Each approach has a stop line, optionally an upstream line, and optionally a queue zone. The direction of travel points from the upstream line to the stop line; without an upstream line it points from the queue zone to the stop line.
- At least two approaches need a stop line and a direction. Otherwise the job is refused (`geometry_incomplete`) and the message names what is missing. Approaches drawn only partly are left out, with a note in the quality warnings.
- Calibration is four points that are the corners of a real rectangle on the road, with the four side lengths in metres. It is refused if two points coincide, three lie on a line, the order crosses over, a distance is not positive, or opposite sides differ by more than 15 percent. The pixel-to-metre map is a homography.

## Tracking

Vehicles are found by the detector (YOLO) and followed with ByteTrack. Boxes are widened by a factor of 1.8 for matching only, so small fast boxes still overlap between frames; the reported boxes are the original ones. A track's class is the confidence-weighted vote over its life, and counts use the final class.

## Counting

- The point that counts is the bottom centre of the box.
- A line is crossed once per track, in the direction of travel only. A crossing needs two observations at least 2 px past the line, the track needs at least 3 observations, and the crossing point must lie within the line's length plus 35 percent. A track that first appears past the line is not counted at it. Jitter inside 2 px counts nothing.
- The crossing time is interpolated between the last observation before the line and the first after, so it does not depend on the frame rate.
- Upstream-line crossings are arrivals. Stop-line crossings are departures.

## Queue and waits

- A vehicle is queued when its bottom centre is in the queue zone and its speed has been under 1 m/s for more than 2 seconds. Speed is a least-squares slope over the last second. Without calibration the limit is 0.15 box heights per second.
- The queue is sampled once per second, as vehicles and as PCU (using the class table you sent).
- A wait runs from the moment a queued vehicle first stopped to the moment it crosses the stop line. Creeping forward does not restart it.

## Speeds

Speed at the stop line, in km/h, from the slope of the last 0.6 seconds of metre positions. Needs calibration. Readings above 130 km/h are tracking errors and are dropped, and counted in a warning.

## Departures and saturation flow

A departure is saturated when another vehicle is still inside that approach's queue zone at the moment it crosses the stop line. Runs of saturated departures give the saturation headway (PCU per second over the run). Green starts are inferred from the first queued vehicle starting to move, minus 1 second of reaction time; the first departure after each green start gives the start-up lost time. If there is too little discharge to measure (under 30 s of saturated flow or fewer than 20 headways) the default value is used and the result says so (`satFlow.isDefault`).

## Quality report

Mean detection confidence; the share of tracks that ended inside the picture away from a line (a sign of hidden or lost vehicles); camera movement from phase correlation once per second; low light from mean brightness; and a low, medium or high risk of missed counts. Warnings are plain sentences. A model with no auto-rickshaw class always raises the medium risk and a warning.

## Determinism

The same video, drawing, options and model give the same result, apart from the timestamps in `meta`. Decode order, track ids, rounding and JSON key order are fixed, and a test compares two full runs.

## Known limits

- Counts depend on the detector. This repository measures the logic against synthetic truth, not the model on real roads; see `MEASUREMENTS.md`.
- Tracking degrades below about 8 processed frames per second, most for small fast vehicles.
- A moving camera, heavy rain, night video and dense two-wheeler traffic are the usual causes of missed counts.
- One lane per approach in the synthetic tests; the lane count only changes how the saturation flow is divided.
