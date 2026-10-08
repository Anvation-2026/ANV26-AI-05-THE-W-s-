import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveRunner } from '../engine/live';
import type { Sim, Veh } from '../engine/sim';
import { VEHICLE_CLASSES, type VehicleClass } from '../contracts';
import { hash01 } from '../engine/rng';
import { phaseName } from '../engine/params';

/** World is 600 x 600 units. About 3.2 units per metre. Left-hand traffic. */
const W = 600;
const C = 300;
const HW = 46; // half width of each arm (inbound half)
const STOP_D = 70;
const UP_D = 214;
const ZOOM = 1.34;
const FRONT_D = 74;
const GAP = 3;

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
const AP_LETTER = ['N', 'S', 'E', 'W'];
const AP_NAME = ['North', 'South', 'East', 'West'];

const DIMS: Record<VehicleClass, { l: number; w: number }> = {
  twoWheeler: { l: 7, w: 3.2 },
  car: { l: 13, w: 6 },
  autoRickshaw: { l: 10, w: 6 },
  bus: { l: 36, w: 8.5 },
  truck: { l: 26, w: 8 },
};

export interface Overlays {
  queueZones?: boolean;
  boxes?: boolean;
  counts?: boolean;
  ids?: boolean;
  speeds?: boolean;
  labels?: boolean;
  signals?: boolean;
}

export interface HighlightRef {
  current: { ap: number; at: number } | null;
}

interface Colors {
  bg: string;
  road: string;
  marking: string;
  muted: string;
  paint: string;
  go: string;
  caution: string;
  stop: string;
  lampOff: string;
  body: string;
  bodyBus: string;
  bodyTruck: string;
  glass: string;
}

function readColors(): Colors {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    bg: v('--asphalt'),
    road: v('--asphalt-2'),
    marking: v('--marking'),
    muted: v('--marking-muted'),
    paint: v('--paint'),
    go: v('--go'),
    caution: v('--caution'),
    stop: v('--stop'),
    lampOff: '#1b201e',
    body: v('--marking'),
    bodyBus: v('--marking-muted'),
    bodyTruck: v('--marking-muted'),
    glass: v('--asphalt'),
  };
}

interface Pos {
  d: number;
  off: number;
  seen: number;
}

let introPlayed = false;

export interface JunctionViewProps {
  runner: LiveRunner;
  simIndex?: number;
  overlays?: Overlays;
  intro?: boolean;
  highlight?: HighlightRef;
  caption?: string;
  className?: string;
}

function worldPoint(ap: number, d: number, off: number) {
  const u = OUT[ap];
  const p = PERP[ap];
  return { x: C + u.x * d + p.x * off, y: C + u.y * d + p.y * off };
}

function lampState(sim: Sim, ap: number): 'green' | 'yellow' | 'red' {
  const aps = sim.phases[sim.signal.phase];
  if (!aps.includes(ap)) return 'red';
  if (sim.signal.stage === 'green') return 'green';
  if (sim.signal.stage === 'yellow') return 'yellow';
  return 'red';
}

export function summaryFor(sim: Sim): string {
  const names = ['North', 'South', 'East', 'West'];
  const q = sim.qSeries.map((s, i) => `${names[i]} ${(s[s.length - 1] ?? 0).toFixed(1)} PCU`).join(', ');
  const st = sim.signal;
  return `Phase ${phaseName(sim.phases[st.phase])} ${st.stage}, ${st.stageT} seconds. Queues: ${q}.`;
}

export function JunctionView({ runner, simIndex = 0, overlays = {}, intro = false, highlight, caption, className }: JunctionViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<Map<number, Pos>>(new Map());
  const colorsRef = useRef<Colors | null>(null);
  const ovRef = useRef(overlays);
  ovRef.current = overlays;
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const summaryRef = useRef('');
  const [summary, setSummary] = useState('');
  const reduced = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const introRef = useRef<{ start: number; on: boolean }>({ start: 0, on: false });

  useEffect(() => {
    if (intro && !introPlayed && !reduced) {
      introRef.current = { start: performance.now(), on: true };
      introPlayed = true;
    } else {
      introRef.current = { start: 0, on: false };
    }
  }, [intro, reduced]);

  useEffect(() => {
    colorsRef.current = readColors();
    const mo = new MutationObserver(() => (colorsRef.current = readColors()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let size = 0;
    let dpr = 1;
    let lastFrame = performance.now();
    let lastSummaryT = -1;
    let lastDrawVersion = -1;
    let settling = true;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      size = Math.max(160, Math.floor(r.width));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(size * dpr);
      canvas.height = Math.floor(size * dpr);
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      settling = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const sim = runner.sims[simIndex];
      const col = colorsRef.current;
      if (!sim || !col) return;
      const dt = Math.min(0.1, (now - lastFrame) / 1000);
      lastFrame = now;
      const introState = introRef.current;
      const ip = introState.on ? Math.min(1, (now - introState.start) / 1400) : 1;
      if (introState.on && ip >= 1) introState.on = false;
      const active =
        runner.playing || settling || introState.on || now - runner.lastChange < 1500 || hoverRef.current !== null || runner.version !== lastDrawVersion;
      if (!active) return;
      lastDrawVersion = runner.version;

      const ov = ovRef.current;
      const frac = runner.playing ? runner.frac : 0;
      const tNow = sim.t + frac;

      const sc = (size * dpr) / W;
      ctx.setTransform(sc * ZOOM, 0, 0, sc * ZOOM, sc * (W / 2) * (1 - ZOOM), sc * (W / 2) * (1 - ZOOM));
      ctx.fillStyle = col.bg;
      ctx.fillRect(-W, -W, W * 3, W * 3);

      // roads
      const roadAlpha = Math.min(1, ip * 3);
      ctx.globalAlpha = roadAlpha;
      ctx.fillStyle = col.road;
      ctx.fillRect(C - HW, 0, HW * 2, W);
      ctx.fillRect(0, C - HW, W, HW * 2);
      ctx.globalAlpha = 1;

      // lane markings, drawn in with a dash reveal during the intro
      ctx.strokeStyle = col.marking;
      ctx.lineWidth = 2;
      ctx.setLineDash([14, 12]);
      const reveal = Math.min(1, Math.max(0, (ip - 0.1) / 0.5));
      const lines: [number, number, number, number][] = [
        [C, 0, C, C - HW - 6],
        [C, C + HW + 6, C, W],
        [0, C, C - HW - 6, C],
        [C + HW + 6, C, W, C],
      ];
      for (const [x1, y1, x2, y2] of lines) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 + (x2 - x1) * reveal, y1 + (y2 - y1) * reveal);
        ctx.stroke();
      }
      // lane divider inside each inbound half
      ctx.strokeStyle = col.muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([8, 10]);
      for (let ap = 0; ap < 4; ap++) {
        const a = worldPoint(ap, STOP_D + 2, HW / 2);
        const b = worldPoint(ap, W / 2 - 2, HW / 2);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + (b.x - a.x) * reveal, a.y + (b.y - a.y) * reveal);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // edge lines and zebra
      ctx.strokeStyle = col.marking;
      ctx.lineWidth = 2;
      ctx.globalAlpha = reveal;
      for (let ap = 0; ap < 4; ap++) {
        for (const side of [-HW, HW]) {
          const a = worldPoint(ap, HW, side);
          const b = worldPoint(ap, W / 2, side);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        // zebra
        ctx.fillStyle = col.marking;
        for (let k = -HW + 5; k < HW - 4; k += 9) {
          const a = worldPoint(ap, 50, k);
          const b = worldPoint(ap, 66, k + 5);
          ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x) || 5, Math.abs(b.y - a.y) || 5);
        }
        // stop line
        ctx.lineWidth = 4;
        const s1 = worldPoint(ap, STOP_D, 0);
        const s2 = worldPoint(ap, STOP_D, HW);
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
        ctx.lineWidth = 2;
      }
      ctx.globalAlpha = 1;
      // junction box edges
      ctx.fillStyle = col.road;
      ctx.fillRect(C - HW + 1, C - HW + 1, HW * 2 - 2, HW * 2 - 2);

      // queue zones
      if (ov.queueZones) {
        for (let ap = 0; ap < 4; ap++) {
          const qv = sim.qSeries[ap][sim.qSeries[ap].length - 1] ?? 0;
          const a = worldPoint(ap, STOP_D + 3, 1);
          const b = worldPoint(ap, STOP_D + 3 + 140, HW - 1);
          ctx.fillStyle = col.paint;
          ctx.globalAlpha = Math.min(0.42, 0.06 + (qv / 36) * 0.4);
          ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          ctx.globalAlpha = 1;
          ctx.strokeStyle = col.paint;
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 5]);
          ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          ctx.setLineDash([]);
        }
      }

      // counting lines
      if (ov.counts) {
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 2;
        for (let ap = 0; ap < 4; ap++) {
          let flash = 0;
          for (let back = 1; back <= 2; back++) {
            const list = sim.arrivals[sim.t - back];
            if (list && list.some((v) => v.ap === ap)) flash = Math.max(flash, 1 - (back - 1 + frac) / 1.2);
          }
          ctx.strokeStyle = flash > 0 ? col.paint : col.muted;
          ctx.globalAlpha = flash > 0 ? 0.5 + flash * 0.5 : 0.8;
          const a = worldPoint(ap, UP_D, 0);
          const b = worldPoint(ap, UP_D, HW);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }

      // vehicles
      const pos = posRef.current;
      const alpha = ip < 0.9 ? 0 : Math.min(1, (ip - 0.9) / 0.1);
      const drawList: { id: number; cls: VehicleClass; d: number; off: number; ap: number; v: Veh; fade: number; kind: 'transit' | 'queue' | 'gone' }[] = [];
      let moved = false;
      const smooth = 1 - Math.exp(-dt * 9);
      for (let ap = 0; ap < 4; ap++) {
        const depth = [FRONT_D, FRONT_D];
        for (const v of sim.queue[ap]) {
          const lane = v.id % 2;
          const dim = DIMS[v.cls];
          const dTarget = depth[lane] + dim.l / 2;
          depth[lane] += dim.l + GAP;
          drawList.push({ id: v.id, cls: v.cls, d: dTarget, off: HW / 4 + lane * (HW / 2), ap, v, fade: 1, kind: 'queue' });
        }
        for (const v of sim.transit[ap]) {
          const lane = v.id % 2;
          const dim = DIMS[v.cls];
          const span = Math.max(1, v.etaQueue - v.arriveT);
          const p = Math.min(1, Math.max(0, (tNow - v.arriveT) / span));
          const dLin = 244 - (244 - (FRONT_D + 10)) * p;
          const tail = depth[lane] + dim.l / 2;
          drawList.push({ id: v.id, cls: v.cls, d: Math.max(dLin, tail), off: HW / 4 + lane * (HW / 2), ap, v, fade: 1, kind: 'transit' });
        }
        for (const r of sim.recentDeparted[ap]) {
          const age = tNow - r.t;
          const lane = r.v.id % 2;
          const dd = STOP_D - 40 * age - DIMS[r.v.cls].l / 2;
          drawList.push({ id: r.v.id, cls: r.v.cls, d: dd, off: HW / 4 + lane * (HW / 2), ap, v: r.v, fade: Math.max(0, 1 - Math.max(0, age - 4) / 4), kind: 'gone' });
        }
      }
      for (const it of drawList) {
        let p = pos.get(it.id);
        if (!p) {
          p = { d: it.d, off: it.off, seen: tNow };
          pos.set(it.id, p);
        } else {
          const k = it.kind === 'gone' ? 1 : smooth;
          const nd = p.d + (it.d - p.d) * k;
          const no = p.off + (it.off - p.off) * k;
          if (Math.abs(nd - p.d) > 0.15 || Math.abs(no - p.off) > 0.15) moved = true;
          p.d = nd;
          p.off = no;
          p.seen = tNow;
        }
      }
      if (pos.size > drawList.length + 40) {
        const alive = new Set(drawList.map((x) => x.id));
        for (const k of pos.keys()) if (!alive.has(k)) pos.delete(k);
      }
      settling = moved || ip < 1;

      ctx.globalAlpha = alpha;
      const boxes: { x: number; y: number; w: number; h: number; it: (typeof drawList)[number] }[] = [];
      for (const it of drawList) {
        const p = pos.get(it.id) as Pos;
        const dim = DIMS[it.cls];
        const pt = worldPoint(it.ap, p.d, p.off);
        const u = OUT[it.ap];
        const ang = Math.atan2(-u.y, -u.x);
        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(ang);
        ctx.globalAlpha = alpha * it.fade;
        drawVehicle(ctx, it.cls, dim.l, dim.w, col, it.v.emergency, Math.floor(now / 250) % 2 === 0);
        ctx.restore();
        const horiz = Math.abs(u.x) > 0;
        boxes.push({ x: pt.x, y: pt.y, w: horiz ? dim.l : dim.w, h: horiz ? dim.w : dim.l, it });
      }
      ctx.globalAlpha = 1;

      // detection boxes
      if (ov.boxes) {
        ctx.font = '8px "Atkinson Hyperlegible Next", sans-serif';
        ctx.textBaseline = 'bottom';
        for (const b of boxes) {
          if (b.it.kind === 'gone') continue;
          const jx = (hash01(b.it.id * 3 + sim.t) - 0.5) * 1.2;
          const jy = (hash01(b.it.id * 5 + sim.t) - 0.5) * 1.2;
          const pad = 3;
          ctx.strokeStyle = col.marking;
          ctx.lineWidth = b.it.cls === 'bus' || b.it.cls === 'truck' ? 1.8 : 1.2;
          const dash: Record<VehicleClass, number[]> = { car: [], twoWheeler: [2, 2], autoRickshaw: [5, 3], bus: [], truck: [9, 3] };
          ctx.setLineDash(dash[b.it.cls]);
          ctx.strokeRect(b.x - b.w / 2 - pad + jx, b.y - b.h / 2 - pad + jy, b.w + pad * 2, b.h + pad * 2);
          ctx.setLineDash([]);
          const conf = 0.55 + hash01(b.it.id * 11) * 0.43;
          const tag = `${b.it.cls === 'twoWheeler' ? 'T' : b.it.cls === 'autoRickshaw' ? 'A' : b.it.cls === 'bus' ? 'B' : b.it.cls === 'truck' ? 'K' : 'C'}${ov.ids ? b.it.id % 1000 : ''} ${conf.toFixed(2)}`;
          ctx.fillStyle = col.marking;
          ctx.fillText(tag, b.x - b.w / 2 - pad + jx, b.y - b.h / 2 - pad + jy - 1);
          if (ov.speeds && b.it.kind === 'transit') {
            ctx.fillText(`${(b.it.v.speed * 3.6).toFixed(0)} km/h`, b.x - b.w / 2 - pad + jx, b.y + b.h / 2 + pad + 9);
          }
        }
      }

      // signal heads
      const headsOn = ip > 0.45 && ov.signals !== false;
      if (headsOn) {
        for (let ap = 0; ap < 4; ap++) {
          const state = ip < 0.7 ? 'red' : lampState(sim, ap);
          const pt = worldPoint(ap, STOP_D + 8, HW + 16);
          ctx.fillStyle = '#0d100f';
          ctx.fillRect(pt.x - 7, pt.y - 17, 14, 34);
          ctx.strokeStyle = col.muted;
          ctx.lineWidth = 1;
          ctx.strokeRect(pt.x - 7, pt.y - 17, 14, 34);
          const lamps: [number, string, string][] = [
            [-11, 'red', col.stop],
            [0, 'yellow', col.caution],
            [11, 'green', col.go],
          ];
          for (const [dy, name, color] of lamps) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y + dy, 4, 0, Math.PI * 2);
            ctx.fillStyle = state === name ? color : col.lampOff;
            ctx.fill();
          }
          if (ov.labels !== false) {
            ctx.fillStyle = col.marking;
            ctx.font = '700 9px "Atkinson Hyperlegible Next", sans-serif';
            ctx.textBaseline = 'middle';
            const p = PERP[ap];
            const tx = pt.x + (p.x >= 0 ? 12 : -12);
            ctx.textAlign = p.x >= 0 ? 'left' : 'right';
            ctx.fillText(state === 'green' ? 'Green' : state === 'yellow' ? 'Yellow' : 'Red', tx, pt.y);
            ctx.textAlign = 'left';
          }
        }
      }

      // approach letters
      ctx.fillStyle = col.marking;
      ctx.font = '800 16px Overpass, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let ap = 0; ap < 4; ap++) {
        const pt = worldPoint(ap, 206, -HW + 14);
        ctx.fillText(AP_LETTER[ap], pt.x, pt.y);
      }
      ctx.textAlign = 'left';

      // queue numbers
      if (ov.queueZones) {
        ctx.font = '700 11px "Atkinson Hyperlegible Next", sans-serif';
        ctx.textBaseline = 'middle';
        for (let ap = 0; ap < 4; ap++) {
          const qv = sim.qSeries[ap][sim.qSeries[ap].length - 1] ?? 0;
          const pt = worldPoint(ap, STOP_D + 78, -HW + 26);
          ctx.fillStyle = col.paint;
          ctx.textAlign = 'center';
          ctx.fillText(`${qv.toFixed(1)} PCU`, pt.x, pt.y);
        }
        ctx.textAlign = 'left';
      }

      // highlight ring and emergency outline
      const hl = highlight?.current;
      for (let ap = 0; ap < 4; ap++) {
        const emerg = sim.queue[ap].some((v) => v.emergency) || sim.transit[ap].some((v) => v.emergency);
        let a = emerg ? 1 : 0;
        if (hl && hl.ap === ap) {
          const age = (now - hl.at) / 600;
          if (age < 1) a = Math.max(a, 1 - age);
        }
        if (a > 0) {
          const p0 = worldPoint(ap, STOP_D - 4, -HW);
          const p1 = worldPoint(ap, W / 2, HW);
          ctx.strokeStyle = col.paint;
          ctx.globalAlpha = a;
          ctx.lineWidth = 3;
          ctx.strokeRect(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
          ctx.globalAlpha = 1;
        }
      }

      // hover tooltip
      const h = hoverRef.current;
      if (h) {
        let best: (typeof boxes)[number] | null = null;
        let bd = 14;
        for (const b of boxes) {
          if (b.it.kind === 'gone') continue;
          const dd = Math.hypot(b.x - h.x, b.y - h.y);
          if (dd < bd) {
            bd = dd;
            best = b;
          }
        }
        if (best) {
          const v = best.it.v;
          const text = `${best.it.cls === 'autoRickshaw' ? 'Auto-rickshaw' : best.it.cls === 'twoWheeler' ? 'Two-wheeler' : best.it.cls[0].toUpperCase() + best.it.cls.slice(1)}${v.emergency ? ', emergency' : ''}. ${AP_NAME[best.it.ap]} approach, ${v.pcu} PCU, ${v.people} people${best.it.kind === 'queue' ? `, waiting ${Math.max(0, sim.t - v.queueT)} s` : ''}.`;
          const r = canvas.getBoundingClientRect();
          setTip({ x: r.left + (((best.x - W / 2) * ZOOM + W / 2) / W) * r.width + 12, y: r.top + (((best.y - W / 2) * ZOOM + W / 2) / W) * r.height + 12, text });
        } else setTip(null);
      }

      if (sim.t !== lastSummaryT) {
        lastSummaryT = sim.t;
        const s = summaryFor(sim);
        if (s !== summaryRef.current) {
          summaryRef.current = s;
          if (sim.t % 5 === 0 || !summaryRef.current) setSummary(s);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [runner, simIndex, highlight]);

  const onMove = (e: React.PointerEvent) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    hoverRef.current = { x: ((e.clientX - r.left) / r.width - 0.5) * (W / ZOOM) + W / 2, y: ((e.clientY - r.top) / r.height - 0.5) * (W / ZOOM) + W / 2 };
  };
  const onLeave = () => {
    hoverRef.current = null;
    setTip(null);
  };

  return (
    <figure className={`junction ${className ?? ''}`} style={{ margin: 0 }}>
      <div ref={wrapRef} className="junction-wrap">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${caption ?? 'Junction plan view'}. ${summary}`}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
        />
      </div>
      {caption && <figcaption className="junction-caption">{caption}</figcaption>}
      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }} role="presentation">
          {tip.text}
        </div>
      )}
    </figure>
  );
}

function drawVehicle(ctx: CanvasRenderingContext2D, cls: VehicleClass, l: number, w: number, col: Colors, emergency: boolean, blink: boolean) {
  const x = -l / 2;
  const y = -w / 2;
  if (cls === 'bus') {
    ctx.fillStyle = col.bodyBus;
    ctx.fillRect(x, y, l, w);
    ctx.fillStyle = col.glass;
    for (let i = 0; i < 6; i++) ctx.fillRect(x + 4 + i * 5, y + 1.6, 3, w - 3.2);
  } else if (cls === 'truck') {
    ctx.fillStyle = col.bodyTruck;
    ctx.fillRect(x, y, l, w);
    ctx.fillStyle = col.body;
    ctx.fillRect(x + l - 8, y, 8, w);
    ctx.fillStyle = col.glass;
    ctx.fillRect(x + l - 4, y + 1.2, 2.5, w - 2.4);
  } else if (cls === 'twoWheeler') {
    ctx.fillStyle = col.body;
    ctx.fillRect(x, y + 0.4, l, w - 0.8);
    ctx.fillRect(x + l - 2.5, y - 1.4, 1.6, w + 2.8);
  } else if (cls === 'autoRickshaw') {
    ctx.fillStyle = col.body;
    ctx.beginPath();
    ctx.moveTo(x, y + 0.5);
    ctx.lineTo(x + l, y + 1.8);
    ctx.lineTo(x + l, y + w - 1.8);
    ctx.lineTo(x, y + w - 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = col.glass;
    ctx.fillRect(x + l - 3.5, y + 2, 1.6, w - 4);
  } else {
    ctx.fillStyle = col.body;
    ctx.fillRect(x, y, l, w);
    ctx.fillStyle = col.glass;
    ctx.fillRect(x + l - 4.6, y + 1, 2.2, w - 2);
    ctx.fillRect(x + 1.5, y + 1, 1.6, w - 2);
  }
  if (emergency) {
    ctx.strokeStyle = col.paint;
    ctx.lineWidth = 1.6;
    ctx.strokeRect(x - 1.5, y - 1.5, l + 3, w + 3);
    ctx.fillStyle = blink ? col.paint : col.stop;
    ctx.fillRect(-2, -2, 4, 4);
  }
}

export const VEHICLE_CLASS_KEYS = VEHICLE_CLASSES;

