import { ArgumentsHost } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AppException } from './errors';
import { ErrorEnvelopeFilter } from './http-exception.filter';

function run(
  exception: unknown,
  headers: Record<string, string> = {},
): { status: number; body: Record<string, any> } {
  const request = { headers };
  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;

  new ErrorEnvelopeFilter().catch(exception, host);
  expect(reply.status).toHaveBeenCalledTimes(1);
  const status = reply.status.mock.calls[0]![0] as number;
  const body = reply.send.mock.calls[0]![0] as Record<string, any>;
  return { status, body };
}

describe('ErrorEnvelopeFilter (API_CONTRACTS envelope)', () => {
  it('renders AppException with its stable code', () => {
    const { status, body } = run(
      new AppException('permission_denied', 'No access to this tenant'),
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe('permission_denied');
    expect(body.error.message).toBe('No access to this tenant');
    expect(body.error.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps framework exceptions by status (401 -> unauthorized)', () => {
    const { status, body } = run(new UnauthorizedException('Invalid credentials'));
    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).toBe('Invalid credentials');
  });

  it('maps 400 -> validation_failed', () => {
    const { status, body } = run(new BadRequestException('Invalid request: email is required'));
    expect(status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
  });

  it('keeps a caller-supplied correlation id', () => {
    const { body } = run(new AppException('rate_limited'), {
      'x-correlation-id': 'corr-123',
    });
    expect(body.error.correlation_id).toBe('corr-123');
  });

  it('never leaks internals from unexpected errors', () => {
    const { status, body } = run(new Error('secret internal detail'));
    expect(status).toBe(500);
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('secret internal detail');
  });

  it('moves class-validator style message lists into details', () => {
    const { body } = run(
      new BadRequestException({ message: ['email must be an email'], error: 'Bad Request' }),
    );
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual(['email must be an email']);
  });
});
