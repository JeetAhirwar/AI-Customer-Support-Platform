import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns ok status for the api service', () => {
    const res = new HealthController().getHealth();
    expect(res.status).toBe('ok');
    expect(res.service).toBe('api');
    expect(Date.parse(res.timestamp)).not.toBeNaN();
  });
});
