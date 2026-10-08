import { describe, expect, it } from 'vitest';
import { boxesAt } from './RecordedVideo';

const det = (id: number, x: number) => ({ id, cls: 'car' as const, x, y: 50, w: 10, h: 10, conf: 0.8 });
const frames = [
  { t: 0, detections: [det(1, 0), det(2, 100)] },
  { t: 0.1, detections: [det(1, 10), det(3, 300)] },
  { t: 0.2, detections: [det(1, 20)] },
];

describe('boxes follow vehicles between analysed pictures', () => {
  it('slides a tracked box between its two positions', () => {
    const at = (t: number) => boxesAt(frames, t, 0.3).find((d) => d.id === 1)!.x;
    expect(at(0)).toBeCloseTo(0);
    expect(at(0.05)).toBeCloseTo(5);
    expect(at(0.075)).toBeCloseTo(7.5);
    expect(at(0.15)).toBeCloseTo(15);
    expect(at(0.2)).toBeCloseTo(20);
  });
  it('keeps a vehicle that is about to leave until halfway, and shows a new one from halfway', () => {
    expect(boxesAt(frames, 0.04, 0.3).map((d) => d.id).sort()).toEqual([1, 2]);
    expect(boxesAt(frames, 0.06, 0.3).map((d) => d.id).sort()).toEqual([1, 3]);
  });
  it('shows nothing far from any analysed picture, and the end pictures near them', () => {
    expect(boxesAt(frames, 5, 0.3)).toEqual([]);
    expect(boxesAt(frames, -1, 0.3)).toEqual([]);
    expect(boxesAt(frames, 0.25, 0.3)).toHaveLength(1);
    expect(boxesAt([], 1, 0.3)).toEqual([]);
  });
  it('does not stretch boxes across a gap in the analysis', () => {
    const gap = [{ t: 0, detections: [det(1, 0)] }, { t: 5, detections: [det(1, 500)] }];
    expect(boxesAt(gap, 2.5, 0.3)).toEqual([]);
    expect(boxesAt(gap, 0.2, 0.3)).toHaveLength(1);
  });
});
