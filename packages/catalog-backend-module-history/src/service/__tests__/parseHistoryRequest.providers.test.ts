import type { Request } from 'express';
import { InputError } from '@backstage/errors';
import {
  parseHistoryChangeFeedRequest,
  parseHistoryProviderSearchRequest,
  parseHistoryRequest,
} from '../parseHistoryRequest';

function request(query: string, parsedQuery: Request['query'] = {}): Request {
  return {
    originalUrl: `/history/providers${query ? `?${query}` : ''}`,
    query: parsedQuery,
    params: { kind: 'component', namespace: 'default', name: 'example' },
  } as unknown as Request;
}

describe('parseHistoryProviderSearchRequest', () => {
  it.each([
    ['provider', 'insert', '1', 1],
    ['processing', 'update', '100', 100],
    ['reconciler', 'delete', '101', 100],
  ])(
    'accepts source %s, operation %s, and limit %s',
    (source, op, limit, expectedLimit) => {
      // Arrange
      const req = request(
        new URLSearchParams({ source, op, limit }).toString(),
      );
      // Act
      const result = parseHistoryProviderSearchRequest(req);
      // Assert
      expect(result).toEqual(
        expect.objectContaining({ source, op, limit: expectedLimit }),
      );
    },
  );

  it('defaults the limit without adding an exact provider filter', () => {
    // Arrange
    const req = request('');
    // Act
    const result = parseHistoryProviderSearchRequest(req);
    // Assert
    expect(result).toEqual(expect.objectContaining({ limit: 25 }));
    expect(Object.hasOwn(result, 'provider')).toBe(false);
    expect(Object.hasOwn(result, 'owner')).toBe(false);
  });

  it.each(['', '%', '_', '\\', "'quoted'", '  MiXeD 雪  ', 'x'.repeat(4096)])(
    'preserves literal prefix %j without trimming or a new length cap',
    prefix => {
      // Arrange
      const req = request(new URLSearchParams({ prefix }).toString());
      // Act
      const result = parseHistoryProviderSearchRequest(req);
      // Assert
      expect(result.prefix).toBe(prefix);
    },
  );

  it.each([
    ['Example', 'component:default/example'],
    ['Other/Example', 'component:other/example'],
    ['User:Example', 'user:default/example'],
  ])(
    'canonicalizes entity reference %s and preserves scope',
    (ref, canonical) => {
      // Arrange
      const filters = {
        prefix: 'Team',
        source: 'processing',
        entityRef: ref,
        kind: 'User',
        op: 'delete',
        changedAfter: '2026-07-07T01:00:00.123456+02:00',
        changedBefore: '2026-07-07T00:00:00.987654Z',
        limit: '101',
        cursor: 'opaque+/=&?%',
      };
      const req = request(new URLSearchParams(filters).toString());
      // Act
      const result = parseHistoryProviderSearchRequest(req);
      // Assert
      expect(result).toEqual({ ...filters, entityRef: canonical, limit: 100 });
      expect(Object.hasOwn(result, 'provider')).toBe(false);
    },
  );

  it('accepts equal inclusive microsecond boundaries unchanged', () => {
    // Arrange
    const time = '2026-07-07T00:00:00.123456Z';
    const req = request(
      new URLSearchParams({
        changedAfter: time,
        changedBefore: time,
      }).toString(),
    );
    // Act
    const result = parseHistoryProviderSearchRequest(req);
    // Assert
    expect(result.changedAfter).toBe(time);
    expect(result.changedBefore).toBe(time);
  });

  it.each([
    'provider=exact',
    'owner=team',
    'unknown=value',
    'prefix=a&prefix=b',
    'prefix=&prefix=',
    'prefix[]=a',
    'prefix[x]=a',
    'source=',
    'entityRef=',
    'kind=',
    'op=',
    'changedAfter=',
    'changedBefore=',
    'limit=',
    'cursor=',
    'source=unknown',
    'op=invalid',
    'kind=Comp%25',
    'kind=Comp_',
    'kind=bad:kind',
    'kind=1Component',
    'entityRef=component:default/',
    'entityRef=bad:kind:default/a',
    'entityRef=component:bad%20namespace/a',
    'limit=0',
    'limit=-1',
    'limit=1.5',
    'limit=9007199254740992',
    'changedAfter=2026-02-30T00:00:00Z',
    'changedBefore=2026-07-07',
    'changedAfter=2026-07-07T00:00:00',
    'changedAfter=2026-07-07T00:00:00%2B24:00',
    'changedAfter=2026-07-08T00:00:00Z&changedBefore=2026-07-07T00:00:00Z',
  ])('rejects invalid raw query %s', query => {
    // Arrange
    const req = request(query);
    // Act
    const parse = () => parseHistoryProviderSearchRequest(req);
    // Assert
    expect(parse).toThrow(InputError);
  });

  it.each([
    'prefix',
    'source',
    'entityRef',
    'kind',
    'op',
    'changedAfter',
    'changedBefore',
    'limit',
    'cursor',
  ])(
    'rejects repeated %s even if the host parser collapses duplicates',
    key => {
      // Arrange
      const req = request(`${key}=a&${key}=b`, { [key]: 'b' });
      // Act
      const parse = () => parseHistoryProviderSearchRequest(req);
      // Assert
      expect(parse).toThrow(InputError);
    },
  );

  it.each(['prefix=', 'prefix=Team'])(
    'does not add provider-prefix support to existing routes: %s',
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

  it('keeps empty exact provider rejection on existing routes', () => {
    // Arrange
    const req = request('provider=');
    // Act
    const feed = () => parseHistoryChangeFeedRequest(req);
    const timeline = () => parseHistoryRequest(req, 'history');
    // Assert
    expect(feed).toThrow(InputError);
    expect(timeline).toThrow(InputError);
  });
});
