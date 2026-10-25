import { describe, expect, it } from 'vitest';
import { AppException } from '../common/errors';
import type { CaseRow, CaseTimelineRow } from './cases.service';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_NOTE_LENGTH,
  parseCaseCursor,
  parseEnum,
  parseEnumList,
  parseLimit,
  parseNoteBody,
  parseObjectBody,
  parseResolveBody,
  parseUuid,
  toApiCase,
  toApiTimelineEvent,
} from './cases.controller';

/** unit coverage for the HTTP boundary: every parser is default-deny. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'no-error';
  } catch (err) {
    return err instanceof AppException
      ? String((err.getResponse() as { code?: string }).code)
      : `unexpected:${err}`;
  }
}

const UUID = '3f2b1c40-9d5e-4a6b-8c7d-1e2f3a4b5c6d';

describe('cases query parsing', () => {
  it('applies the default limit and enforces bounds', () => {
    expect(parseLimit(undefined, DEFAULT_LIMIT, MAX_LIMIT)).toBe(25);
    expect(parseLimit('10', DEFAULT_LIMIT, MAX_LIMIT)).toBe(10);
    expect(codeOf(() => parseLimit('0', DEFAULT_LIMIT, MAX_LIMIT))).toBe(
      'validation_failed',
    );
    expect(codeOf(() => parseLimit('101', DEFAULT_LIMIT, MAX_LIMIT))).toBe(
      'validation_failed',
    );
    expect(codeOf(() => parseLimit('12.5', DEFAULT_LIMIT, MAX_LIMIT))).toBe(
      'validation_failed',
    );
    expect(codeOf(() => parseLimit('abc', DEFAULT_LIMIT, MAX_LIMIT))).toBe(
      'validation_failed',
    );
  });

  it('accepts only uuids, lowercased', () => {
    expect(parseUuid(UUID.toUpperCase(), 'id')).toBe(UUID);
    expect(codeOf(() => parseUuid('not-a-uuid', 'id'))).toBe(
      'validation_failed',
    );
    expect(codeOf(() => parseUuid(undefined, 'id'))).toBe('validation_failed');
    // a SQL-injection-shaped id is just an invalid uuid, never a query
    expect(codeOf(() => parseUuid(`${UUID}' OR 1=1--`, 'id'))).toBe(
      'validation_failed',
    );
  });

  it('decodes a keyset cursor and rejects a malformed one', () => {
    const cursor = parseCaseCursor(`2026-01-02T03:04:05.678Z|${UUID}`);
    expect(cursor?.at).toBe('2026-01-02T03:04:05.678Z');
    expect(cursor?.id).toBe(UUID);
    // microseconds survive the round trip (JS Date would truncate them)
    const micros = parseCaseCursor(`2026-01-02T03:04:05.678901Z|${UUID}`);
    expect(micros?.at).toBe('2026-01-02T03:04:05.678901Z');
    expect(parseCaseCursor(undefined)).toBeUndefined();
    expect(codeOf(() => parseCaseCursor('12|nope'))).toBe('validation_failed');
    expect(codeOf(() => parseCaseCursor(UUID))).toBe('validation_failed');
  });

  it('validates multi-valued filters against the schema vocabulary', () => {
    expect(parseEnumList('new,open', ['new', 'open'] as const, 'status')).toEqual([
      'new',
      'open',
    ]);
    expect(parseEnumList(['new', 'open'], ['new', 'open'] as const, 'status')).toEqual([
      'new',
      'open',
    ]);
    expect(parseEnumList(undefined, ['new'] as const, 'status')).toBeUndefined();
    expect(parseEnumList('', ['new'] as const, 'status')).toBeUndefined();
    expect(codeOf(() => parseEnumList('new,closedd', ['new'] as const, 'status'))).toBe(
      'validation_failed',
    );
  });

  it('validates single-valued filters', () => {
    expect(parseEnum('overdue', ['overdue'] as const, 'sla')).toBe('overdue');
    expect(parseEnum(undefined, ['overdue'] as const, 'sla')).toBeUndefined();
    expect(codeOf(() => parseEnum('soon', ['overdue'] as const, 'sla'))).toBe(
      'validation_failed',
    );
    expect(codeOf(() => parseEnum('sms', ['chat', 'email'] as const, 'channel'))).toBe(
      'validation_failed',
    );
  });
});

describe('cases body parsing', () => {
  it('rejects unknown fields (high-risk endpoint rule)', () => {
    expect(codeOf(() => parseObjectBody({ body: 'x', extra: 1 }, ['body']))).toBe(
      'validation_failed',
    );
    expect(
      codeOf(() => parseResolveBody({ resolution_code: 'fixed', note: 'x' })),
    ).toBe('validation_failed');
  });

  it('requires a non-empty note body within the size cap', () => {
    expect(parseNoteBody({ body: 'ship it' })).toEqual({ body: 'ship it' });
    expect(codeOf(() => parseNoteBody(undefined))).toBe('validation_failed');
    expect(codeOf(() => parseNoteBody({}))).toBe('validation_failed');
    expect(codeOf(() => parseNoteBody({ body: '   ' }))).toBe(
      'validation_failed',
    );
    expect(codeOf(() => parseNoteBody({ body: 42 }))).toBe(
      'validation_failed',
    );
    expect(codeOf(() => parseNoteBody(['body']))).toBe('validation_failed');
    expect(
      codeOf(() => parseNoteBody({ body: 'x'.repeat(MAX_NOTE_LENGTH + 1) })),
    ).toBe('validation_failed');
  });

  it('treats an absent resolve body as "no resolution code"', () => {
    expect(parseResolveBody(undefined)).toEqual({});
    expect(parseResolveBody({})).toEqual({});
    expect(parseResolveBody({ resolution_code: 'fixed.by.agent' })).toEqual({
      resolution_code: 'fixed.by.agent',
    });
    expect(codeOf(() => parseResolveBody({ resolution_code: '' }))).toBe(
      'validation_failed',
    );
    expect(codeOf(() => parseResolveBody({ resolution_code: 'a b' }))).toBe(
      'validation_failed',
    );
    expect(
      codeOf(() => parseResolveBody({ resolution_code: 'x'.repeat(65) })),
    ).toBe('validation_failed');
  });
});

describe('response mapping', () => {
  const row: CaseRow = {
    id: UUID,
    tenant_id: 't-1',
    customer_id: 'c-1',
    conversation_id: null,
    status: 'open',
    priority: 'normal',
    queue_id: null,
    assignee_id: null,
    sla_due_at: new Date('2026-01-02T03:04:05.678Z'),
    resolution_code: null,
    resolved_at: null,
    reopened_at: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at_text: '2026-01-01T00:00:00.000000Z',
    customer_name: 'Ada',
    customer_email: 'ada@example.test',
    queue_name: null,
    channel: 'chat',
    assignee_email: null,
  };

  it('renders timestamps as ISO strings and absent values as null', () => {
    const api = toApiCase(row);
    expect(api.id).toBe(UUID);
    expect(api.sla_due_at).toBe('2026-01-02T03:04:05.678Z');
    expect(api.resolved_at).toBeNull();
    expect(api.assignee_email).toBeNull();
    expect(api.channel).toBe('chat');
    expect(JSON.parse(JSON.stringify(api))).toEqual(api); // JSON-safe
  });

  it('maps a timeline entry with its metadata intact', () => {
    const event: CaseTimelineRow = {
      id: 'e-1',
      event_type: 'case.resolved',
      actor_type: 'agent',
      actor_id: 'u-1',
      metadata: { previous_status: 'open' },
      occurred_at: new Date('2026-01-03T00:00:00.000Z'),
      occurred_at_text: '2026-01-03T00:00:00.000000Z',
    };
    expect(toApiTimelineEvent(event)).toEqual({
      id: 'e-1',
      event_type: 'case.resolved',
      actor_type: 'agent',
      actor_id: 'u-1',
      metadata: { previous_status: 'open' },
      occurred_at: '2026-01-03T00:00:00.000Z',
    });
  });
});
