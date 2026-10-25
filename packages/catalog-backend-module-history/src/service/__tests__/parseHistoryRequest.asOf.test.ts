import type { Request } from 'express';
import { InputError } from '@backstage/errors';
import { parseHistoryEntityAsOfRequest } from '../parseHistoryRequest';

const timestamp = '2026-07-07T01:00:00.123456+02:00';
function request(
  query: string,
  params = { kind: 'Component', namespace: 'DeFaUlT', name: 'Example' },
): Request {
  return {
    originalUrl: `/history/entities/Component/DeFaUlT/Example/as-of?${query}`,
    query: Object.fromEntries(new URLSearchParams(query)),
    params,
  } as unknown as Request;
}

describe('as-of request parser', () => {
  it.each(['provider', 'processing', 'reconciler'])(
    'preserves raw precision, offset and exact provider for %s',
    source => {
      // Arrange
      const provider = '  MiXeD%_雪 Provider  ';
      const req = request(
        new URLSearchParams({ timestamp, source, provider }).toString(),
      );
      // Act
      const result = parseHistoryEntityAsOfRequest(req);
      // Assert
      expect(result).toEqual({
        entityRef: 'component:default/example',
        timestamp,
        source,
        provider,
      });
    },
  );

  it('projects only as-of fields without pagination or cycle defaults', () => {
    // Arrange
    const req = request(new URLSearchParams({ timestamp }).toString());
    // Act
    const result = parseHistoryEntityAsOfRequest(req);
    // Assert
    expect(result).toEqual({
      entityRef: 'component:default/example',
      timestamp,
    });
    expect(Object.keys(result).sort()).toEqual([
      'entityRef',
      'provider',
      'source',
      'timestamp',
    ]);
  });

  it.each([
    '',
    'timestamp=',
    'timestamp=2026-02-30T00:00:00Z',
    'timestamp=2025-02-29T00:00:00Z',
    'timestamp=2026-07-07',
    'timestamp=2026-07-07T00:00:00',
    'timestamp=2026-07-07T24:00:00Z',
    'timestamp=2026-07-07T00:60:00Z',
    'timestamp=2026-07-07T00:00:60Z',
    'timestamp=2026-07-07T00:00:00%2B24:00',
    'timestamp=2026-07-07T00:00:00%2B00:60',
    'timestamp[]=2026-07-07T00:00:00Z',
  ])('rejects missing or invalid timestamp query %s', query => {
    // Arrange
    const req = request(query);
    // Act
    const action = () => parseHistoryEntityAsOfRequest(req);
    // Assert
    expect(action).toThrow(InputError);
  });

  it.each([
    'unknown',
    'limit',
    'cursor',
    'op',
    'owner',
    'kind',
    'entityRef',
    'cycleId',
    'cycleTargets',
    'changedAfter',
    'changedBefore',
    'startedAfter',
    'startedBefore',
    'finishedAfter',
    'finishedBefore',
  ])('rejects unrelated %s instead of introducing selectors', key => {
    // Arrange
    const req = request(
      new URLSearchParams({ timestamp, [key]: 'value' }).toString(),
    );
    // Act
    const action = () => parseHistoryEntityAsOfRequest(req);
    // Assert
    expect(action).toThrow(InputError);
  });

  it.each(['timestamp', 'source', 'provider'])(
    'rejects duplicate %s despite collapsed Express query values',
    key => {
      // Arrange
      const query = new URLSearchParams({
        timestamp,
        source: 'provider',
        provider: 'exact',
      });
      query.append(key, query.get(key)!);
      const req = request(query.toString());
      // Act
      const action = () => parseHistoryEntityAsOfRequest(req);
      // Assert
      expect(action).toThrow(InputError);
    },
  );

  it.each(['source=', 'source=unknown', 'source=Provider', 'provider='])(
    'rejects invalid optional context %s',
    query => {
      // Arrange
      const req = request(`${new URLSearchParams({ timestamp })}&${query}`);
      // Act
      const action = () => parseHistoryEntityAsOfRequest(req);
      // Assert
      expect(action).toThrow(InputError);
    },
  );

  it.each([
    { kind: '1Bad', namespace: 'default', name: 'example' },
    { kind: 'Component', namespace: 'bad namespace', name: 'example' },
    { kind: 'Component', namespace: 'default', name: 'bad/name' },
  ])('rejects invalid path %j', params => {
    // Arrange
    const req = request(new URLSearchParams({ timestamp }).toString(), params);
    // Act
    const action = () => parseHistoryEntityAsOfRequest(req);
    // Assert
    expect(action).toThrow(InputError);
  });

  it('accepts a leap day without rewriting the timestamp', () => {
    // Arrange
    const leap = '2024-02-29T00:00:00.000001-05:30';
    const req = request(new URLSearchParams({ timestamp: leap }).toString());
    // Act
    const result = parseHistoryEntityAsOfRequest(req);
    // Assert
    expect(result.timestamp).toBe(leap);
  });
});
