import type { Calibration, Geometry, Point } from '../contracts';
import { APPROACHES } from '../contracts';

/** The sample junction is drawn in a 600 by 600 frame. About 3.2 units per metre. */
export const SAMPLE_FRAME = { w: 600, h: 600 };
export const UNITS_PER_METRE = 3.2;

const OUT = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: 1, y: 0 },
  { x: -1, y: 0 },
];
const PERP = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];
const at = (ap: number, d: number, off: number): Point => ({ x: 300 + OUT[ap].x * d + PERP[ap].x * off, y: 300 + OUT[ap].y * d + PERP[ap].y * off });

export function sampleGeometry(): Geometry {
  const g: Geometry = { stopLines: {}, upstreamLines: {}, queueZones: {} };
  APPROACHES.forEach((a, ap) => {
    g.stopLines[a] = { a: at(ap, 70, 0), b: at(ap, 70, 46) };
    g.upstreamLines[a] = { a: at(ap, 272, 0), b: at(ap, 272, 46) };
    g.queueZones[a] = [at(ap, 73, 1), at(ap, 73, 45), at(ap, 263, 45), at(ap, 263, 1)];
  });
  return g;
}

export function sampleCalibration(): Calibration {
  return {
    points: [
      { x: 254, y: 254 },
      { x: 346, y: 254 },
      { x: 346, y: 346 },
      { x: 254, y: 346 },
    ],
    distances: [28.8, 28.8, 28.8, 28.8],
  };
}

export function emptyGeometry(): Geometry {
  return { stopLines: {}, upstreamLines: {}, queueZones: {} };
}

export function countGeometry(g: Geometry): { stop: number; up: number; zone: number } {
  return {
    stop: APPROACHES.filter((a) => g.stopLines[a]).length,
    up: APPROACHES.filter((a) => g.upstreamLines[a]).length,
    zone: APPROACHES.filter((a) => (g.queueZones[a]?.length ?? 0) >= 3).length,
  };
}
