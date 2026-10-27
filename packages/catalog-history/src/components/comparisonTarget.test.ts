import {
  formatComparisonParam,
  orderComparison,
  parseComparisonParams,
} from './comparisonTarget';

const ref = 'component:default/example';

describe('orderComparison', () => {
  it('orders the older event first whichever was picked first', () => {
    // Arrange
    const older = { id: '7', changedAt: '2026-10-01T00:00:00.000Z' };
    const newer = { id: '3', changedAt: '2026-10-02T00:00:00.000Z' };
    // Act / Assert
    expect(orderComparison(ref, newer, older)).toEqual({
      entityRef: ref,
      fromId: '7',
      toId: '3',
    });
    expect(orderComparison(ref, older, newer)).toEqual({
      entityRef: ref,
      fromId: '7',
      toId: '3',
    });
  });

  it('breaks equal recorded times by row ID beyond Number precision', () => {
    // Arrange: both IDs round to the same JavaScript number.
    const at = '2026-10-01T00:00:00.000Z';
    const lower = { id: '9007199254740992', changedAt: at };
    const higher = { id: '9007199254740993', changedAt: at };
    // Act
    const result = orderComparison(ref, higher, lower);
    // Assert
    expect(result).toMatchObject({ fromId: lower.id, toId: higher.id });
  });

  it('breaks ties between opaque IDs from custom APIs as text', () => {
    // Arrange: a custom API may use non-numeric event IDs.
    const at = '2026-10-01T00:00:00.000Z';
    const a = { id: 'synthetic-event-1', changedAt: at };
    const b = { id: 'synthetic-event-2', changedAt: at };
    // Act / Assert
    expect(orderComparison(ref, b, a)).toMatchObject({
      fromId: a.id,
      toId: b.id,
    });
  });
});

describe('comparison URL parameters', () => {
  it('round-trips a comparison', () => {
    // Arrange
    const target = { entityRef: ref, fromId: '12', toId: '9' };
    const params = new URLSearchParams({
      compare: formatComparisonParam(target),
      compareRef: ref,
    });
    // Act / Assert
    expect(params.get('compare')).toBe('12..9');
    expect(parseComparisonParams(params)).toEqual(target);
  });

  it('keeps opaque event IDs for custom APIs', () => {
    // Arrange
    const params = new URLSearchParams({
      compare: 'synthetic-event-6..synthetic-event-9',
      compareRef: ref,
    });
    // Act / Assert
    expect(parseComparisonParams(params)).toEqual({
      entityRef: ref,
      fromId: 'synthetic-event-6',
      toId: 'synthetic-event-9',
    });
  });

  it.each([
    ['', ref],
    ['1..2', ''],
    ['1..2..3', ref],
    ['1..1', ref],
    ['..2', ref],
    ['1..', ref],
    ['1', ref],
  ])('ignores compare=%j compareRef=%j', (compare, compareRef) => {
    // Arrange
    const params = new URLSearchParams();
    if (compare) params.set('compare', compare);
    if (compareRef) params.set('compareRef', compareRef);
    // Act / Assert
    expect(parseComparisonParams(params)).toBeUndefined();
  });
});
