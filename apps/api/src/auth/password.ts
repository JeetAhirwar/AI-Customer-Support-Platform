import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Argon2id password hashing (SECURITY.md §auth: "Argon2id ... memory-hard
 * parameters per current OWASP guidance" — OWASP Password Storage Cheat Sheet:
 * m=19456 KiB (19 MiB), t=2, p=1).
 */
const ARGON2ID_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2ID_OPTIONS);
}

export async function verifyPassword(
  passwordHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, plaintext, ARGON2ID_OPTIONS);
  } catch {
    // malformed/foreign hash format → treat as failure, never as match
    return false;
  }
}
