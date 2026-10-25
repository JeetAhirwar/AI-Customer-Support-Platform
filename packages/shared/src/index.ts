/** Public API version prefix used by HTTP routes (see API_CONTRACTS.md). */
export const API_VERSION = 'v1';

export * from './logger';

/** Health payload shape shared by api/worker health endpoints. */
export interface HealthPayload {
  status: 'ok' | 'degraded';
  service: 'api' | 'worker';
  timestamp: string;
}
