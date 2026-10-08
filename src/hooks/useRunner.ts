import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { EmergencyEvent } from '../contracts';
import { LiveRunner, type SimFactory } from '../engine/live';

/** Creates a LiveRunner for a page and rebuilds it when the factory inputs change. */
export function useRunner(factory: SimFactory, horizon: number, deps: unknown[]): LiveRunner {
  const ref = useRef<LiveRunner | null>(null);
  const first = useRef(true);
  if (!ref.current) ref.current = new LiveRunner(factory, horizon);
  const runner = ref.current;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    runner.rebuild(factory, horizon);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => () => runner.dispose(), [runner]);
  useSyncExternalStore(runner.subscribe, runner.getVersion);
  return runner;
}

export function useMemoFactory<T extends (e: EmergencyEvent[]) => unknown>(fn: T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => fn, deps);
}
