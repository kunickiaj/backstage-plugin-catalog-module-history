import { InputError } from '@backstage/errors';
import type { Request } from 'express';
import {
  parseHistoryCycleDetailRequest,
  parseHistoryCycleListRequest,
} from '../parseHistoryRequest';

const cycleId = 'a1234567-89ab-cdef-0123-456789abcdef';
const listKeys = [
  'source',
  'provider',
  'op',
  'mutationType',
  'startedAfter',
  'startedBefore',
  'finishedAfter',
  'finishedBefore',
  'limit',
  'cursor',
];

function request(
  query = '',
  id = cycleId,
  parsed: Request['query'] = {},
): Request {
  return {
    originalUrl: `/history/cycles/${id}${query ? `?${query}` : ''}`,
    query: parsed,
    params: { cycleId: id },
  } as unknown as Request;
}

describe.each([
  ['list', parseHistoryCycleListRequest],
  ['detail', parseHistoryCycleDetailRequest],
] as const)('cycle %s pagination parser', (_name, parse) => {
  it('defaults to 25 without adding entity context', () => {
    // Arrange
    const req = request();
    // Act
    const result = parse(req);
    // Assert
    expect(result.limit).toBe(25);
    expect(result).not.toHaveProperty('entityRef');
    expect(result).not.toHaveProperty('changedAfter');
  });

  it.each([
    ['1', 1],
    ['100', 100],
    ['101', 100],
  ])('accepts limit %s as %s and an opaque cursor', (limit, expected) => {
    // Arrange
    const cursor = 'opaque+/=&?%雪';
    const req = request(new URLSearchParams({ limit, cursor }).toString());
    // Act
    const result = parse(req);
    // Assert
    expect(result.limit).toBe(expected);
    expect(result.cursor).toBe(cursor);
  });

  it.each([
    'limit=',
    'cursor=',
    'limit=0',
    'limit=-1',
    'limit=1.5',
    'limit=1e2',
    'limit=9007199254740992',
    'limit=NaN',
    'limit=Infinity',
    'limit=01',
    'entityRef=component:default/a',
    'entity=a',
    'kind=User',
    'owner=team',
    'prefix=a',
    'changedAfter=2026-07-07T00:00:00Z',
    'changedBefore=2026-07-07T00:00:00Z',
    'unknown=value',
    'limit[]=1',
    'cursor[x]=a',
  ])('rejects unsupported or invalid query %s', query => {
    // Arrange
    const req = request(query);
    // Act
    const action = () => parse(req);
    // Assert
    expect(action).toThrow(InputError);
  });

  it.each(['limit', 'cursor'])(
    'rejects duplicate %s even with collapsed Express parsing',
    key => {
      // Arrange
      const req = request(`${key}=1&${key}=2`, cycleId, { [key]: '2' });
      // Act
      const action = () => parse(req);
      // Assert
      expect(action).toThrow(InputError);
    },
  );
});

describe('cycle list filters', () => {
  it.each([
    ['provider', 'insert', 'full'],
    ['processing', 'update', 'delta'],
    ['reconciler', 'delete', 'delta'],
  ])('preserves declared filters for %s/%s/%s', (source, op, mutationType) => {
    // Arrange: API strings retain offset and microsecond precision.
    const filters = {
      source,
      op,
      mutationType,
      provider: "  MiXeD%_\\'雪  ",
      startedAfter: '2026-07-07T01:00:00.123456+02:00',
      startedBefore: '2026-07-07T00:00:00.987654Z',
      finishedAfter: '2026-07-07T02:00:00.123456+02:00',
      finishedBefore: '2026-07-07T01:00:00.987654Z',
      limit: '7',
      cursor: 'opaque+/=&?%',
    };
    const req = request(new URLSearchParams(filters).toString());
    // Act
    const result = parseHistoryCycleListRequest(req);
    // Assert
    expect(result).toEqual({ ...filters, limit: 7 });
  });

  it.each(listKeys)(
    'rejects empty or repeated %s independently of parsed query style',
    key => {
      // Arrange
      const empty = request(`${key}=`);
      const repeated = request(`${key}=a&${key}=b`, cycleId, { [key]: 'b' });
      // Act
      const parseEmpty = () => parseHistoryCycleListRequest(empty);
      const parseRepeated = () => parseHistoryCycleListRequest(repeated);
      // Assert
      expect(parseEmpty).toThrow(InputError);
      expect(parseRepeated).toThrow(InputError);
    },
  );

  it.each([
    'source=Provider',
    'source=future',
    'op=INSERT',
    'op=unchanged',
    'mutationType=FULL',
    'mutationType=future',
  ])('rejects enum query %s', query => {
    // Arrange
    const req = request(query);
    // Act
    const action = () => parseHistoryCycleListRequest(req);
    // Assert
    expect(action).toThrow(InputError);
  });

  it.each(['started', 'finished'])(
    'accepts equal %s bounds and independent cross-window constraints',
    prefix => {
      // Arrange: incompatible start/finish windows are a valid query with no matches.
      const time = '2026-07-07T00:00:00.123456Z';
      const filters = { [`${prefix}After`]: time, [`${prefix}Before`]: time };
      const req = request(new URLSearchParams(filters).toString());
      const cross = request(
        'startedAfter=2026-07-08T00:00:00Z&finishedBefore=2026-07-07T00:00:00Z',
      );
      // Act
      const result = parseHistoryCycleListRequest(req);
      const crossResult = parseHistoryCycleListRequest(cross);
      // Assert
      expect(result).toMatchObject(filters);
      expect(crossResult.startedAfter).toBe('2026-07-08T00:00:00Z');
      expect(crossResult.finishedBefore).toBe('2026-07-07T00:00:00Z');
    },
  );

  it.each(['startedAfter', 'startedBefore', 'finishedAfter', 'finishedBefore'])(
    'validates calendar and timezone on %s',
    key => {
      // Arrange
      const invalid = [
        '2026-02-30T00:00:00Z',
        '2026-07-07',
        '2026-07-07T00:00:00',
        '2026-07-07T00:00:00+24:00',
        '2026-07-07T00:00:00+01:60',
      ];
      const requests = invalid.map(value =>
        request(new URLSearchParams({ [key]: value }).toString()),
      );
      // Act
      const actions = requests.map(
        req => () => parseHistoryCycleListRequest(req),
      );
      // Assert
      actions.forEach(action => expect(action).toThrow(InputError));
    },
  );

  it.each(['started', 'finished'])(
    'rejects reversed %s bounds including sub-millisecond differences',
    prefix => {
      // Arrange
      const req = request(
        new URLSearchParams({
          [`${prefix}After`]: '2026-07-07T00:00:00.123457Z',
          [`${prefix}Before`]: '2026-07-07T00:00:00.123456Z',
        }).toString(),
      );
      // Act
      const action = () => parseHistoryCycleListRequest(req);
      // Assert
      expect(action).toThrow(InputError);
    },
  );
});

describe('cycle detail identity', () => {
  it.each([
    cycleId,
    cycleId.toUpperCase(),
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])('accepts canonical UUID shape %s without restricting version', id => {
    // Arrange
    const req = request('', id);
    // Act
    const result = parseHistoryCycleDetailRequest(req);
    // Assert
    expect(result).toEqual({
      cycleId: id.toLowerCase(),
      limit: 25,
      cursor: undefined,
    });
  });

  it.each([
    'not-a-uuid',
    '',
    '123',
    `${cycleId}/suffix`,
    `${cycleId}\\suffix`,
    `${cycleId}?x`,
    `${cycleId}%2F`,
    cycleId.replace(/-/g, ''),
    cycleId.replace('a', 'g'),
  ])('rejects malformed path identity %j', id => {
    // Arrange
    const req = request('', id);
    // Act
    const action = () => parseHistoryCycleDetailRequest(req);
    // Assert
    expect(action).toThrow(InputError);
  });

  it.each(listKeys.filter(key => !['limit', 'cursor'].includes(key)))(
    'rejects list filter %s on detail',
    key => {
      // Arrange
      const req = request(`${key}=provider`);
      // Act
      const action = () => parseHistoryCycleDetailRequest(req);
      // Assert
      expect(action).toThrow(InputError);
    },
  );
});
