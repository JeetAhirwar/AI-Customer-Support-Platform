import { describe, expect, it } from 'vitest';
import { API_VERSION } from './index';

describe('@aicsp/shared', () => {
  it('exposes the v1 API prefix', () => {
    expect(API_VERSION).toBe('v1');
  });
});
