import {
  ensureSchema,
  historyStoreServiceFactory,
  PostgresHistoryStore,
  RECONCILER_PROVIDER,
} from '@kunickiaj/backstage-plugin-catalog-backend-module-history';
import type {
  CaptureSource,
  CurrentEtag,
  CycleInput,
  EntityRow,
  HistoryStore,
  MutationType,
} from '@kunickiaj/backstage-plugin-catalog-backend-module-history';
import { RECONCILER_PROVIDER as canonicalReconcilerProvider } from '@kunickiaj/backstage-plugin-catalog-history-node';
import type {
  CaptureSource as CanonicalCaptureSource,
  CurrentEtag as CanonicalCurrentEtag,
  CycleInput as CanonicalCycleInput,
  EntityRow as CanonicalEntityRow,
  HistoryStore as CanonicalHistoryStore,
  MutationType as CanonicalMutationType,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import {
  ensureSchema as canonicalEnsureSchema,
  historyStoreServiceFactory as canonicalHistoryStoreServiceFactory,
  PostgresHistoryStore as CanonicalPostgresHistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-storage-node';

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;

function typeCheck<T>(value: T): T {
  return value;
}

describe('deprecated public compatibility exports', () => {
  it.each([
    ['RECONCILER_PROVIDER', RECONCILER_PROVIDER, canonicalReconcilerProvider],
    ['ensureSchema', ensureSchema, canonicalEnsureSchema],
    [
      'historyStoreServiceFactory',
      historyStoreServiceFactory,
      canonicalHistoryStoreServiceFactory,
    ],
    [
      'PostgresHistoryStore',
      PostgresHistoryStore,
      CanonicalPostgresHistoryStore,
    ],
  ])('preserves the canonical identity of %s', (_name, legacy, canonical) => {
    // Arrange: both imports use public package entrypoints, without mocks.
    const expected = canonical;

    // Act: importing must not require opening a database or creating a service.
    const actual = legacy;

    // Assert: two missing exports must not accidentally satisfy identity.
    expect(expected).toBeDefined();
    expect(actual).toBe(expected);
  });

  it('preserves all six canonical store contract types', () => {
    // Arrange: root tsc checks these consumer imports; Jest only strips types.
    const matches = [
      typeCheck<Equal<CaptureSource, CanonicalCaptureSource>>(true),
      typeCheck<Equal<CurrentEtag, CanonicalCurrentEtag>>(true),
      typeCheck<Equal<CycleInput, CanonicalCycleInput>>(true),
      typeCheck<Equal<EntityRow, CanonicalEntityRow>>(true),
      typeCheck<Equal<HistoryStore, CanonicalHistoryStore>>(true),
      typeCheck<Equal<MutationType, CanonicalMutationType>>(true),
    ];

    // Act
    const allMatch = matches.every(match => match);

    // Assert
    expect(allMatch).toBe(true);
  });

  it('supports historical typed imports when preparing a recording cycle', () => {
    // Arrange: an existing consumer can still annotate its recording input.
    const source: CaptureSource = 'reconciler';
    const mutationType: MutationType = 'delta';
    const input: CycleInput = {
      cycleId: 'compatibility-cycle',
      provider: RECONCILER_PROVIDER,
      source,
      mutationType,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:01Z'),
      inserts: [],
      updates: [],
      deletes: ['component:default/removed'],
      unchangedCount: 0,
    };

    // Act: the canonical API accepts the historical consumer's input unchanged.
    const canonicalInput = typeCheck<CanonicalCycleInput>(input);

    // Assert
    expect(canonicalInput).toBe(input);
  });

  it('rejects invalid historical consumer contracts at compile time', () => {
    // Arrange: unused @ts-expect-error directives fail root tsc if types weaken.
    // @ts-expect-error CaptureSource does not accept an unknown capture layer.
    const source = typeCheck<CaptureSource>('unknown');
    // @ts-expect-error CurrentEtag requires the recording provider.
    const etag = typeCheck<CurrentEtag>({ etag: 'etag' });
    // @ts-expect-error CycleInput requires the full recording cycle contract.
    const cycle = typeCheck<CycleInput>({ cycleId: 'incomplete' });
    // @ts-expect-error EntityRow requires entity content, not only a reference.
    const row = typeCheck<EntityRow>({
      entityRef: 'component:default/example',
    });
    // @ts-expect-error HistoryStore requires callable storage methods.
    const store = typeCheck<HistoryStore>({ recordCycle: 'not-a-function' });
    // @ts-expect-error MutationType describes cycle shapes, not row operations.
    const mutation = typeCheck<MutationType>('delete');

    // Act: keep the compile fixtures observable without calling storage methods.
    const invalidInputs = [source, etag, cycle, row, store, mutation];

    // Assert: runtime does not validate types; root tsc verifies rejection above.
    expect(invalidInputs).toHaveLength(6);
  });
});
