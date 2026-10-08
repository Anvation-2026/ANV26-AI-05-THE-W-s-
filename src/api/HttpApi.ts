import { NotConnectedError, type SignalTwinApi } from './SignalTwinApi';

/**
 * Placeholder for the Python back end (FastAPI). Replace each method with a
 * fetch call that sends and receives the shapes in src/contracts, then export
 * `new HttpApi(baseUrl)` as `api` in MockApi.ts.
 *
 * Suggested routes, all JSON unless noted:
 *   GET  /junction                    -> JunctionConfig
 *   PUT  /junction                    <- JunctionConfig
 *   POST /perception        (multipart video + JunctionConfig) -> PerceptionResult, with progress over SSE
 *   POST /demand/estimate             <- {source, junction, params} -> DemandEstimate
 *   POST /simulate                    <- SimRequest -> SimResult
 *   POST /experiments       (server-sent events for progress) <- ExperimentRequest -> ExperimentResult
 */
export class HttpApi implements SignalTwinApi {
  constructor(private baseUrl: string) {}
  getJunction(): never {
    throw new NotConnectedError(`GET ${this.baseUrl}/junction`);
  }
  saveJunction(): never {
    throw new NotConnectedError(`PUT ${this.baseUrl}/junction`);
  }
  analyseVideo(): never {
    throw new NotConnectedError(`POST ${this.baseUrl}/perception`);
  }
  estimateDemand(): never {
    throw new NotConnectedError(`POST ${this.baseUrl}/demand/estimate`);
  }
  runSimulation(): never {
    throw new NotConnectedError(`POST ${this.baseUrl}/simulate`);
  }
  runExperiment(): never {
    throw new NotConnectedError(`POST ${this.baseUrl}/experiments`);
  }
}
