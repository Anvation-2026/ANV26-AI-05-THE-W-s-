import { useMemo } from 'react';
import { useApp } from '../store/app';
import { baseProfile, extendProfile } from '../engine/demand';
import { SCENARIOS } from '../engine/params';
import type { RunSetup } from '../engine/experiment';
import type { Scenario } from '../contracts';

/** Builds the run setup from the saved junction, parameters and demand. */
export function useSetup(scenario?: Scenario, patch?: Partial<RunSetup>): RunSetup {
  const params = useApp((s) => s.params);
  const options = useApp((s) => s.options);
  const junction = useApp((s) => s.junction);
  const demand = useApp((s) => s.demand);
  const scenarioId = useApp((s) => s.scenarioId);
  const baseDemand = useMemo(() => {
    if (demand) return extendProfile(demand, params.horizon);
    return baseProfile(params, params.horizon);
  }, [demand, params]);
  return useMemo(
    () => ({
      params,
      options,
      baseDemand,
      scenario: scenario ?? SCENARIOS[scenarioId],
      observed: junction.observed,
      ...patch,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params, options, baseDemand, scenario, scenarioId, junction.observed, patch?.noise, patch?.emergencies],
  );
}
