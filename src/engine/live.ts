import type { EmergencyEvent } from '../contracts';
import type { Sim } from './sim';

export type SimFactory = (emergencies: EmergencyEvent[]) => Sim[];

/**
 * Drives one or more simulations in real time for the animated views.
 * The sims share a clock, so a "Current plan" sim and a "SignalTwin" sim
 * always show the same second of the same traffic.
 */
export class LiveRunner {
  sims: Sim[] = [];
  playing = false;
  speed = 1;
  frac = 0;
  version = 0;
  lastChange = 0;
  horizon: number;
  emergencies: EmergencyEvent[] = [];
  private listeners = new Set<() => void>();
  private raf = 0;
  private last = 0;
  private acc = 0;
  private pending = false;

  constructor(
    private factory: SimFactory,
    horizon: number,
  ) {
    this.horizon = horizon;
    this.sims = factory(this.emergencies);
  }

  get t(): number {
    return this.sims[0]?.t ?? 0;
  }
  get ended(): boolean {
    return this.t >= this.horizon;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getVersion = () => this.version;

  private lastEmit = 0;
  /** React subscribers are throttled to about 5 per second while playing. Canvases read the runner directly. */
  private notify(force = true) {
    this.version++;
    const now = performance.now();
    this.lastChange = now;
    if (!force && now - this.lastEmit < 200) return;
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.lastEmit = performance.now();
      this.listeners.forEach((l) => l());
    });
  }

  play() {
    if (this.ended) this.seek(0);
    if (this.playing) return;
    this.playing = true;
    this.last = performance.now();
    this.loop();
    this.notify();
  }
  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.notify();
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  setSpeed(s: number) {
    this.speed = s;
    this.notify();
  }
  stepOnce() {
    this.pause();
    this.advance(1);
    this.frac = 0;
    this.notify();
  }

  private advance(n: number) {
    for (let i = 0; i < n && this.t < this.horizon; i++) for (const s of this.sims) s.step();
  }

  private loop = () => {
    if (!this.playing) return;
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000) * this.speed;
    this.last = now;
    this.acc += dt;
    let steps = Math.floor(this.acc);
    if (steps > 0) {
      this.acc -= steps;
      steps = Math.min(steps, 30);
      this.advance(steps);
    }
    this.frac = this.acc;
    if (this.ended) {
      this.playing = false;
      this.frac = 0;
    }
    this.notify(!this.playing);
    if (this.playing) this.raf = requestAnimationFrame(this.loop);
  };

  /** Rebuild from the factory and fast-forward to second t. Used after any setting changes. */
  seek(t: number) {
    const target = Math.max(0, Math.min(this.horizon, Math.round(t)));
    this.sims = this.factory(this.emergencies);
    this.acc = 0;
    this.frac = 0;
    this.advance(target);
    this.notify();
  }
  reset() {
    this.emergencies = [];
    this.seek(0);
  }
  rebuild(factory?: SimFactory, horizon?: number) {
    if (factory) this.factory = factory;
    if (horizon) this.horizon = horizon;
    this.seek(this.t);
  }

  /** Trigger an emergency vehicle on an approach now, in every sim. */
  triggerEmergency(approach: number) {
    const t = this.t;
    this.emergencies = [...this.emergencies, { t, approach }];
    for (const s of this.sims) s.injectEmergency(approach);
    this.notify();
  }

  dispose() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.listeners.clear();
  }
}

