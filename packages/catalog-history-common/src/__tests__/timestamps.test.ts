import { compareHistoryInstants, isHistoryInstant } from '../timestamps';

describe('isHistoryInstant', () => {
  it.each([
    '2026-10-24T12:00:00Z',
    '2026-10-24T12:00:00.123456Z',
    '2024-02-29T00:00:00+15:59',
    '2026-10-24T23:59:59-08:00',
  ])('accepts %s', value => {
    expect(isHistoryInstant(value)).toBe(true);
  });

  it.each([
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-10-24T24:00:00Z',
    '2026-10-24T12:00:00',
    '2026-10-24 12:00:00Z',
    '2026-10-24T12:00:00+16:00',
    '2026-10-24',
    '',
    undefined,
    1,
  ])('rejects %p', value => {
    expect(isHistoryInstant(value)).toBe(false);
  });
});

describe('compareHistoryInstants', () => {
  it('orders instants across offsets', () => {
    expect(
      compareHistoryInstants(
        '2026-10-24T12:00:00+02:00',
        '2026-10-24T11:00:00Z',
      ),
    ).toBeLessThan(0);
  });

  it('orders fractions below one millisecond', () => {
    const earlier = '2026-10-24T12:00:00.000100Z';
    const later = '2026-10-24T12:00:00.0002Z';
    expect(compareHistoryInstants(earlier, later)).toBeLessThan(0);
    expect(compareHistoryInstants(later, earlier)).toBeGreaterThan(0);
    expect(
      compareHistoryInstants(
        '2026-10-24T12:00:00.1Z',
        '2026-10-24T12:00:00.100000Z',
      ),
    ).toBe(0);
  });
});
