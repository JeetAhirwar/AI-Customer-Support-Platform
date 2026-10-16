import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password (argon2id)', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('Synthetic!Pass123');
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, 'Synthetic!Pass123')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('Synthetic!Pass123');
    await expect(verifyPassword(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('treats a malformed hash as failure, never as a match', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('produces unique salts (same password → different hashes)', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);
    expect(a).not.toBe(b);
  });
});
