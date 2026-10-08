import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Back end connection state. The address comes from VITE_API_URL at build time (see .env.example). When it is not set,
 * the app never contacts a server, which also keeps the browser console free of failed requests. A person can set or
 * change the address in the Back end dialog, for example to point at a shared server.
 */
const ENV_URL = (import.meta.env.VITE_API_URL as string | undefined)?.trim() || '';

export type BackendStatus = 'checking' | 'connected' | 'degraded' | 'offline' | 'none';

export interface BackendInfo {
  status: string;
  version: string;
  pipelineVersion: string;
  model: { available: boolean; name: string; detector: string };
  storage: { kind: string; freeGb: number };
  queue: { queued: number; running: number; workers: number; queueMax: number };
  authRequired: boolean;
  message: string | null;
}

export interface BackendLimits {
  maxUploadMb: number;
  maxDurationS: number;
  minDurationS: number;
  maxWidth: number;
  acceptedFormats: string[];
  retentionHours: number;
  queueMax: number;
}

interface BackendState {
  urlOverride: string;
  simulation: 'browser' | 'server';
  status: BackendStatus;
  info: BackendInfo | null;
  limits: BackendLimits | null;
  checkedAt: number;
  error: string | null;
  apiKey: string;
  setUrl: (u: string) => void;
  setSimulation: (s: 'browser' | 'server') => void;
  setApiKey: (k: string) => void;
  check: () => Promise<void>;
}

const KEY_STORE = 'signaltwin-api-key';
function readKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORE) ?? '';
  } catch {
    return '';
  }
}

function storedOverride(): string {
  try {
    return (JSON.parse(localStorage.getItem('signaltwin-backend-v1') ?? '{}') as { state?: { urlOverride?: string } })?.state?.urlOverride ?? '';
  } catch {
    return '';
  }
}

export const useBackend = create<BackendState>()(
  persist(
    (set, get) => ({
      urlOverride: '',
      simulation: 'browser',
      status: ENV_URL || storedOverride() ? 'checking' : 'none',
      info: null,
      limits: null,
      checkedAt: 0,
      error: null,
      apiKey: readKey(),
      setUrl: (urlOverride) => {
        set({ urlOverride });
        void get().check();
      },
      setSimulation: (simulation) => set({ simulation }),
      setApiKey: (apiKey) => {
        try {
          sessionStorage.setItem(KEY_STORE, apiKey);
        } catch {
          /* private mode */
        }
        set({ apiKey });
        void get().check();
      },
      check: async () => {
        const url = baseUrl();
        if (!url) {
          set({ status: 'none', info: null, limits: null, error: null, checkedAt: Date.now() });
          return;
        }
        if (get().status === 'none') set({ status: 'checking' });
        const ctrl = new AbortController();
        const timer = window.setTimeout(() => ctrl.abort(), 4000);
        try {
          const r = await fetch(`${url}/v1/health`, { signal: ctrl.signal, cache: 'no-store' });
          if (!r.ok) throw new Error(`The server answered ${r.status}.`);
          const info = (await r.json()) as BackendInfo;
          let limits = get().limits;
          try {
            const headers: Record<string, string> = get().apiKey ? { 'X-API-Key': get().apiKey } : {};
            const lr = await fetch(`${url}/v1/limits`, { headers, signal: ctrl.signal });
            if (lr.ok) limits = (await lr.json()) as BackendLimits;
          } catch {
            /* limits are advisory */
          }
          set({ status: info.model.available ? 'connected' : 'degraded', info, limits, error: null, checkedAt: Date.now() });
        } catch (e) {
          const aborted = e instanceof DOMException && e.name === 'AbortError';
          set({ status: 'offline', info: null, error: aborted ? `No answer from ${url} within 4 seconds.` : `Could not reach ${url}.`, checkedAt: Date.now() });
        } finally {
          window.clearTimeout(timer);
        }
      },
    }),
    { name: 'signaltwin-backend-v1', storage: createJSONStorage(() => localStorage), partialize: (s) => ({ urlOverride: s.urlOverride, simulation: s.simulation }) },
  ),
);

export function baseUrl(): string {
  const o = useBackend.getState().urlOverride.trim();
  return (o || ENV_URL).replace(/\/+$/, '');
}

/** True when the server answered health and its model is loaded, so video analysis can run. */
export const backendReady = (): boolean => useBackend.getState().status === 'connected';
/** True when the server answers at all. Demand estimation does not need the model. */
export const backendUp = (): boolean => {
  const s = useBackend.getState().status;
  return s === 'connected' || s === 'degraded';
};

/** Checks at start-up, every 30 seconds, and whenever the tab becomes visible again. */
let started = false;
export function startBackendMonitor() {
  if (started) return;
  started = true;
  void useBackend.getState().check();
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void useBackend.getState().check();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void useBackend.getState().check();
  });
}
