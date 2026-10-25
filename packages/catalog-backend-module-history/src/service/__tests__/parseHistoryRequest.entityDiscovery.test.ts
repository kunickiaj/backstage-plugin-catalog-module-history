import type { Request } from 'express';
import { InputError } from '@backstage/errors';
import {
  parseHistoryChangeFeedRequest,
  parseHistoryEntitySearchRequest,
  parseHistoryKindSearchRequest,
  parseHistoryRequest,
} from '../parseHistoryRequest';

function request(query: string, parsedQuery: Request['query'] = {}): Request {
  return {
    originalUrl: `/history/entities${query ? `?${query}` : ''}`,
    query: parsedQuery,
    params: { kind: 'component', namespace: 'default', name: 'example' },
  } as unknown as Request;
}

const parsers = [
  ['entities', parseHistoryEntitySearchRequest],
  ['kinds', parseHistoryKindSearchRequest],
] as const;

describe.each(parsers)('%s discovery raw query parser', (_endpoint, parse) => {
  it('defaults pagination without introducing unrelated own properties', () => {
    // Arrange
    const req = request('');
    // Act
    const result = parse(req);
    // Assert
    expect(result.limit).toBe(25);
    expect(Object.hasOwn(result, 'entityRef')).toBe(false);
    expect(Object.hasOwn(result, 'owner')).toBe(false);
  });

  it.each(['', '%', '_', '\\', "'quoted'", '  MiXeD 雪  ', 'x'.repeat(4096)])(
    'preserves literal prefix %j',
    prefix => {
      // Arrange
      const req = request(new URLSearchParams({ prefix }).toString());
      // Act
      const result = parse(req);
      // Assert
      expect(result.prefix).toBe(prefix);
    },
  );

  it.each([
    ['1', 1],
    ['100', 100],
    ['101', 100],
  ])(
    'accepts limit %s as %s and preserves opaque cursors',
    (limit, expected) => {
      // Arrange
      const cursor = 'opaque+/=&?%雪';
      const req = request(new URLSearchParams({ limit, cursor }).toString());
      // Act
      const result = parse(req);
      // Assert
      expect(result.limit).toBe(expected);
      expect(result.cursor).toBe(cursor);
    },
  );

  it.each([
    'entityRef=component:default/a',
    'owner=team',
    'unknown=value',
    'prefix=a&prefix=b',
    'prefix=&prefix=',
    'prefix[]=a',
    'prefix[x]=a',
    'limit=',
    'cursor=',
    'limit=0',
    'limit=-1',
    'limit=1.5',
    'limit=9007199254740992',
    'limit=NaN',
    'limit=Infinity',
  ])('rejects invalid raw query %s', query => {
    // Arrange
    const req = request(query);
    // Act
    const action = () => parse(req);
    // Assert
    expect(action).toThrow(InputError);
  });

  it.each(['prefix', 'limit', 'cursor'])(
    'rejects duplicate %s despite collapsed host query parsing',
    key => {
      // Arrange
      const req = request(`${key}=1&${key}=2`, { [key]: '2' });
      // Act
      const action = () => parse(req);
      // Assert
      expect(action).toThrow(InputError);
    },
  );
});

describe('entity discovery context', () => {
  it('does not add unrelated undefined properties to kind requests', () => {
    // Arrange
    const req = request('');
    // Act
    const result = parseHistoryKindSearchRequest(req);
    // Assert
    expect(Object.keys(result).sort()).toEqual(['cursor', 'limit', 'prefix']);
  });

  it.each([
    ['provider', 'insert'],
    ['processing', 'update'],
    ['reconciler', 'delete'],
  ])(
    'accepts source %s and operation %s with exact provider and raw dates',
    (source, op) => {
      // Arrange
      const filters = {
        prefix: '  User:Teams/%_雪  ',
        kind: 'User',
        source,
        op,
        provider: '  MiXeD%_Provider  ',
        changedAfter: '2026-07-07T01:00:00.123456+02:00',
        changedBefore: '2026-07-07T00:00:00.987654Z',
        cursor: 'opaque+/=',
        limit: '7',
      };
      const req = request(new URLSearchParams(filters).toString());
      // Act
      const result = parseHistoryEntitySearchRequest(req);
      // Assert
      expect(result).toEqual({ ...filters, limit: 7 });
      expect(Object.hasOwn(result, 'entityRef')).toBe(false);
    },
  );

  it('preserves equal inclusive microsecond bounds', () => {
    // Arrange
    const time = '2026-07-07T00:00:00.123456Z';
    const req = request(
      new URLSearchParams({
        changedAfter: time,
        changedBefore: time,
      }).toString(),
    );
    // Act
    const result = parseHistoryEntitySearchRequest(req);
    // Assert
    expect(result.changedAfter).toBe(time);
    expect(result.changedBefore).toBe(time);
  });

  it.each([
    'source=',
    'provider=',
    'kind=',
    'op=',
    'changedAfter=',
    'changedBefore=',
    'source=unknown',
    'op=invalid',
    'kind=Comp%25',
    'kind=Comp_',
    'kind=bad:kind',
    'kind=1Component',
    'changedAfter=2026-02-30T00:00:00Z',
    'changedBefore=2026-07-07',
    'changedAfter=2026-07-07T00:00:00',
    'changedAfter=2026-07-07T00:00:00%2B24:00',
    'changedAfter=2026-07-08T00:00:00Z&changedBefore=2026-07-07T00:00:00Z',
  ])('rejects invalid entity context %s', query => {
    // Arrange
    const req = request(query);
    // Act
    const action = () => parseHistoryEntitySearchRequest(req);
    // Assert
    expect(action).toThrow(InputError);
  });

  it.each([
    'source',
    'provider',
    'kind',
    'op',
    'changedAfter',
    'changedBefore',
  ])('rejects duplicate entity context %s before semantic validation', key => {
    // Arrange
    const req = request(`${key}=provider&${key}=provider`, {
      [key]: 'provider',
    });
    // Act
    const action = () => parseHistoryEntitySearchRequest(req);
    // Assert
    expect(action).toThrow(InputError);
  });

  it.each([
    'source',
    'provider',
    'entityRef',
    'entity',
    'kind',
    'op',
    'changedAfter',
    'changedBefore',
    'owner',
  ])('rejects %s on kind discovery', key => {
    // Arrange
    const req = request(new URLSearchParams({ [key]: 'value' }).toString());
    // Act
    const action = () => parseHistoryKindSearchRequest(req);
    // Assert
    expect(action).toThrow(InputError);
  });

  it.each(['prefix=', 'prefix=Team', 'provider='])(
    'keeps existing feed and timeline rejection of %s',
    query => {
      // Arrange
      const req = request(query);
      // Act
      const feed = () => parseHistoryChangeFeedRequest(req);
      const timeline = () => parseHistoryRequest(req, 'history');
      // Assert
      expect(feed).toThrow(InputError);
      expect(timeline).toThrow(InputError);
    },
  );
});
