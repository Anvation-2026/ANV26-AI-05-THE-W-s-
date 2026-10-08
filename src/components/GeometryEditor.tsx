import { useEffect, useRef, useState, type ReactNode } from 'react';
import { APPROACHES, type Approach, type Geometry, type Line, type Point } from '../contracts';
import { applyH, dist, type Mat3 } from '../lib/homography';

export type Tool = 'select' | 'stop' | 'upstream' | 'zone' | 'calibrate';
type Sel = { kind: 'stop' | 'upstream' | 'zone' | 'cal'; ap?: Approach; idx: number } | null;

export interface GeometryEditorProps {
  frame: { w: number; h: number };
  background: ReactNode;
  geometry: Geometry;
  onGeometry: (g: Geometry) => void;
  tool: Tool;
  approach: Approach;
  calPoints: Point[];
  onCalPoints: (p: Point[]) => void;
  H?: Mat3 | null;
  visible?: { geometry: boolean; calibration: boolean };
  onMessage?: (m: string) => void;
}

const clone = (g: Geometry): Geometry => JSON.parse(JSON.stringify(g));

export function GeometryEditor(p: GeometryEditorProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<{ kind: 'stop' | 'upstream'; ap: Approach; a: Point; b: Point } | null>(null);
  const [zone, setZone] = useState<{ ap: Approach; pts: Point[]; cursor: Point | null } | null>(null);
  const drag = useRef<{ sel: NonNullable<Sel> } | null>(null);
  const r = p.frame.w / 80;
  const vis = p.visible ?? { geometry: true, calibration: true };

  useEffect(() => {
    setDraft(null);
    setZone(null);
  }, [p.tool, p.approach]);

  const toFrame = (e: { clientX: number; clientY: number }): Point => {
    const b = svg.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(p.frame.w, ((e.clientX - b.left) / b.width) * p.frame.w)), y: Math.max(0, Math.min(p.frame.h, ((e.clientY - b.top) / b.height) * p.frame.h)) };
  };

  const setPoint = (s: NonNullable<Sel>, pt: Point) => {
    if (s.kind === 'cal') {
      const next = p.calPoints.slice();
      next[s.idx] = pt;
      p.onCalPoints(next);
      return;
    }
    const g = clone(p.geometry);
    if (s.kind === 'zone') {
      const z = g.queueZones[s.ap!];
      if (z) z[s.idx] = pt;
    } else {
      const map = s.kind === 'stop' ? g.stopLines : g.upstreamLines;
      const l = map[s.ap!];
      if (l) map[s.ap!] = s.idx === 0 ? { a: pt, b: l.b } : { a: l.a, b: pt };
    }
    p.onGeometry(g);
  };

  const getPoint = (s: NonNullable<Sel>): Point | null => {
    if (s.kind === 'cal') return p.calPoints[s.idx] ?? null;
    if (s.kind === 'zone') return p.geometry.queueZones[s.ap!]?.[s.idx] ?? null;
    const l = (s.kind === 'stop' ? p.geometry.stopLines : p.geometry.upstreamLines)[s.ap!];
    return l ? (s.idx === 0 ? l.a : l.b) : null;
  };

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as Element).getAttribute('data-handle')) return;
    const pt = toFrame(e);
    if (p.tool === 'stop' || p.tool === 'upstream') {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDraft({ kind: p.tool, ap: p.approach, a: pt, b: pt });
      setSel(null);
    } else if (p.tool === 'zone') {
      setZone((z) => {
        if (!z || z.ap !== p.approach) return { ap: p.approach, pts: [pt], cursor: pt };
        if (z.pts.length >= 3 && dist(pt, z.pts[0]) < r * 2.5) {
          closeZone(z.pts);
          return null;
        }
        return { ...z, pts: [...z.pts, pt] };
      });
    } else if (p.tool === 'calibrate') {
      if (p.calPoints.length < 4) p.onCalPoints([...p.calPoints, pt]);
      else p.onMessage?.('Four points are placed. Drag a point to move it, or clear the points to start again.');
    } else {
      setSel(null);
    }
  };

  const closeZone = (pts: Point[]) => {
    if (pts.length < 3) return p.onMessage?.('A queue zone needs at least three points.');
    const g = clone(p.geometry);
    g.queueZones[p.approach] = pts;
    p.onGeometry(g);
    setSel({ kind: 'zone', ap: p.approach, idx: 0 });
  };

  const onMove = (e: React.PointerEvent) => {
    const pt = toFrame(e);
    if (draft) setDraft({ ...draft, b: pt });
    else if (zone) setZone({ ...zone, cursor: pt });
    else if (drag.current) setPoint(drag.current.sel, pt);
  };

  const onUp = () => {
    if (draft) {
      if (dist(draft.a, draft.b) < r * 1.5) {
        p.onMessage?.('That line is too short. Press at one end and drag to the other.');
      } else {
        const g = clone(p.geometry);
        const line: Line = { a: draft.a, b: draft.b };
        if (draft.kind === 'stop') g.stopLines[draft.ap] = line;
        else g.upstreamLines[draft.ap] = line;
        p.onGeometry(g);
        setSel({ kind: draft.kind, ap: draft.ap, idx: 1 });
      }
      setDraft(null);
    }
    drag.current = null;
  };

  const beginDrag = (s: NonNullable<Sel>) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { sel: s };
    setSel(s);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setZone(null);
      setDraft(null);
      setSel(null);
      return;
    }
    if (e.key === 'Enter' && zone) {
      e.preventDefault();
      closeZone(zone.pts);
      setZone(null);
      return;
    }
    if (!sel) return;
    const step = e.shiftKey ? 10 : 1;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (d[e.key]) {
      e.preventDefault();
      const cur = getPoint(sel);
      if (cur) setPoint(sel, { x: Math.max(0, Math.min(p.frame.w, cur.x + d[e.key][0])), y: Math.max(0, Math.min(p.frame.h, cur.y + d[e.key][1])) });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      setSel(null);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (sel.kind === 'cal') {
        p.onCalPoints(p.calPoints.filter((_, i) => i !== sel.idx));
      } else {
        const g = clone(p.geometry);
        if (sel.kind === 'stop') delete g.stopLines[sel.ap!];
        else if (sel.kind === 'upstream') delete g.upstreamLines[sel.ap!];
        else delete g.queueZones[sel.ap!];
        p.onGeometry(g);
      }
      setSel(null);
    }
  };

  const metres = (a: Point, b: Point): string | null => {
    if (!p.H) return null;
    return `${dist(applyH(p.H, a), applyH(p.H, b)).toFixed(1)} m`;
  };

  const handle = (s: NonNullable<Sel>, pt: Point, label: string, key: string) => {
    const on = sel && sel.kind === s.kind && sel.ap === s.ap && sel.idx === s.idx;
    return (
      <g key={key}>
        <rect
          data-handle="1"
          x={pt.x - r}
          y={pt.y - r}
          width={r * 2}
          height={r * 2}
          fill={on ? 'var(--paint)' : 'var(--asphalt)'}
          stroke={on ? 'var(--asphalt)' : 'var(--paint)'}
          strokeWidth={r / 4}
          tabIndex={0}
          role="button"
          aria-label={label}
          style={{ cursor: 'move', touchAction: 'none' }}
          onPointerDown={beginDrag(s)}
          onFocus={() => setSel(s)}
        />
      </g>
    );
  };

  const lineEl = (kind: 'stop' | 'upstream', ap: Approach, l: Line) => {
    const on = sel && sel.kind === kind && sel.ap === ap;
    const mid = { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 };
    const m = metres(l.a, l.b);
    return (
      <g key={`${kind}${ap}`}>
        <line x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} stroke="var(--paint)" strokeWidth={on ? r / 1.5 : r / 2.4} strokeDasharray={kind === 'upstream' ? `${r * 1.5} ${r}` : undefined} />
        <text x={mid.x + r} y={mid.y - r} fontSize={r * 2.2} fontWeight="700" fill="var(--paint)" stroke="var(--asphalt)" strokeWidth={r / 3} paintOrder="stroke">
          {ap} {kind === 'stop' ? 'stop' : 'upstream'} {Math.round(dist(l.a, l.b))} px{m ? `, ${m}` : ''}
        </text>
        {handle({ kind, ap, idx: 0 }, l.a, `${ap} ${kind} line, first end`, `${kind}${ap}0`)}
        {handle({ kind, ap, idx: 1 }, l.b, `${ap} ${kind} line, second end`, `${kind}${ap}1`)}
      </g>
    );
  };

  return (
    <div className="canvas-stage">
      {p.background}
      <svg
        ref={svg}
        className="overlay"
        viewBox={`0 0 ${p.frame.w} ${p.frame.h}`}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: p.tool === 'select' ? 'default' : 'crosshair', touchAction: 'none' }}
        tabIndex={0}
        role="application"
        aria-label="Junction drawing area. Choose a tool, then press and drag to draw. Select a handle and use the arrow keys to move it. Press Delete to remove the shape. Press Enter to finish a queue zone."
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={() => zone && zone.pts.length >= 3 && (closeZone(zone.pts), setZone(null))}
        onKeyDown={onKey}
      >
        {vis.geometry &&
          APPROACHES.map((a) => {
            const g = p.geometry;
            return (
              <g key={a}>
                {g.queueZones[a] && g.queueZones[a]!.length >= 3 && (
                  <g>
                    <polygon points={g.queueZones[a]!.map((q) => `${q.x},${q.y}`).join(' ')} fill="var(--paint)" fillOpacity="0.16" stroke="var(--paint)" strokeWidth={r / 3} strokeDasharray={`${r} ${r / 1.5}`} />
                    <text x={g.queueZones[a]![0].x} y={g.queueZones[a]![0].y - r} fontSize={r * 2.2} fontWeight="700" fill="var(--paint)" stroke="var(--asphalt)" strokeWidth={r / 3} paintOrder="stroke">
                      {a} queue zone
                    </text>
                    {g.queueZones[a]!.map((q, i) => handle({ kind: 'zone', ap: a, idx: i }, q, `${a} queue zone, point ${i + 1}`, `z${a}${i}`))}
                  </g>
                )}
                {g.stopLines[a] && lineEl('stop', a, g.stopLines[a]!)}
                {g.upstreamLines[a] && lineEl('upstream', a, g.upstreamLines[a]!)}
              </g>
            );
          })}
        {draft && <line x1={draft.a.x} y1={draft.a.y} x2={draft.b.x} y2={draft.b.y} stroke="var(--paint)" strokeWidth={r / 2} strokeDasharray={draft.kind === 'upstream' ? `${r} ${r}` : undefined} />}
        {draft && (
          <text x={(draft.a.x + draft.b.x) / 2 + r} y={(draft.a.y + draft.b.y) / 2 - r} fontSize={r * 2.2} fontWeight="700" fill="var(--paint)" stroke="var(--asphalt)" strokeWidth={r / 3} paintOrder="stroke">
            {Math.round(dist(draft.a, draft.b))} px{metres(draft.a, draft.b) ? `, ${metres(draft.a, draft.b)}` : ''}
          </text>
        )}
        {zone && (
          <g>
            <polyline points={[...zone.pts, ...(zone.cursor ? [zone.cursor] : [])].map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke="var(--paint)" strokeWidth={r / 2.4} strokeDasharray={`${r} ${r / 1.5}`} />
            {zone.pts.map((q, i) => (
              <rect key={i} x={q.x - r / 1.5} y={q.y - r / 1.5} width={(r / 1.5) * 2} height={(r / 1.5) * 2} fill="var(--paint)" />
            ))}
          </g>
        )}
        {vis.calibration && p.calPoints.length > 1 && (
          <polygon points={p.calPoints.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke="var(--marking)" strokeWidth={r / 3} strokeDasharray={`${r / 1.2} ${r / 1.2}`} />
        )}
        {vis.calibration &&
          p.calPoints.map((q, i) => (
            <g key={`c${i}`}>
              {handle({ kind: 'cal', idx: i }, q, `Calibration point ${i + 1}`, `cal${i}`)}
              <text x={q.x + r * 1.4} y={q.y - r * 1.2} fontSize={r * 2.4} fontWeight="800" fill="var(--marking)" stroke="var(--asphalt)" strokeWidth={r / 3} paintOrder="stroke">
                P{i + 1}
              </text>
            </g>
          ))}
      </svg>
    </div>
  );
}

/** Static plan-view frame that stands in for the camera on the sample junction. */
export function SampleFrame() {
  const arm = (x: number, y: number, w: number, h: number) => <rect x={x} y={y} width={w} height={h} fill="var(--asphalt-2)" />;
  return (
    <svg viewBox="0 0 600 600" style={{ display: 'block', width: '100%', height: 'auto', background: 'var(--asphalt)' }} role="img" aria-label="Plan view of the sample junction, four arms meeting at a square junction">
      {arm(254, 0, 92, 600)}
      {arm(0, 254, 600, 92)}
      <g stroke="var(--marking)" strokeWidth="2" strokeDasharray="14 12">
        <line x1="300" y1="0" x2="300" y2="248" />
        <line x1="300" y1="352" x2="300" y2="600" />
        <line x1="0" y1="300" x2="248" y2="300" />
        <line x1="352" y1="300" x2="600" y2="300" />
      </g>
      <g stroke="var(--marking)" strokeWidth="2">
        <line x1="254" y1="0" x2="254" y2="254" />
        <line x1="346" y1="0" x2="346" y2="254" />
        <line x1="254" y1="346" x2="254" y2="600" />
        <line x1="346" y1="346" x2="346" y2="600" />
        <line x1="0" y1="254" x2="254" y2="254" />
        <line x1="0" y1="346" x2="254" y2="346" />
        <line x1="346" y1="254" x2="600" y2="254" />
        <line x1="346" y1="346" x2="600" y2="346" />
      </g>
      <g fill="var(--marking)" fontFamily="Overpass" fontWeight="800" fontSize="16" textAnchor="middle">
        <text x="322" y="20">N</text>
        <text x="278" y="590">S</text>
        <text x="585" y="326">E</text>
        <text x="14" y="278">W</text>
      </g>
    </svg>
  );
}
