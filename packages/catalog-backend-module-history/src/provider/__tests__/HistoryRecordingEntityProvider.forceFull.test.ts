import { mockServices } from '@backstage/backend-test-utils';
import type {
  EntityProvider,
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import { InMemoryHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node/testUtils';
import type { ForceFullEveryDuration } from '../HistoryRecordingEntityProvider';
import { HistoryRecordingEntityProvider } from '../HistoryRecordingEntityProvider';

const full: EntityProviderMutation = {
  type: 'full',
  entities: [
    {
      entity: {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'User',
        metadata: { name: 'example', etag: 'v1' },
      },
    },
  ],
};
const delta: EntityProviderMutation = {
  type: 'delta',
  added: [],
  removed: [],
};

async function setup(forceFullEvery?: ForceFullEveryDuration) {
  const store = new InMemoryHistoryStore();

  async function connect(interval?: ForceFullEveryDuration) {
    let wrapped: EntityProviderConnection | undefined;
    const inner: EntityProvider = {
      getProviderName: () => 'example-provider',
      connect: async connection => {
        wrapped = connection;
      },
    };
    const applyMutation = jest.fn().mockResolvedValue(undefined);
    const wrapper = new HistoryRecordingEntityProvider({
      inner,
      store,
      logger: mockServices.logger.mock(),
      convertFullToDelta: true,
      forceFullEvery: interval,
    });
    await wrapper.connect({ applyMutation, refresh: jest.fn() });
    if (!wrapped) throw new Error('Provider did not connect');
    return { wrapped, applyMutation };
  }

  // Persist a baseline with an earlier wrapper, then restart without emitting.
  const previous = await connect();
  await previous.wrapped.applyMutation(full);
  return { store, ...(await connect(forceFullEvery)) };
}

describe('HistoryRecordingEntityProvider forceFullEvery after restart', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('forwards the first full with persisted history and resets at exact expiry', async () => {
    // Arrange: history exists, but this wrapper has not forwarded a full.
    const { wrapped, applyMutation } = await setup({ seconds: 30 });

    // Act
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(10_000);
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(20_000);
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(10_000);
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(20_000);
    await wrapped.applyMutation(full);

    // Assert: converted snapshots do not reset the interval.
    expect(applyMutation.mock.calls.map(([mutation]) => mutation.type)).toEqual(
      ['full', 'delta', 'full', 'delta', 'full'],
    );
  });

  it('does not start the full interval when a native delta arrives first', async () => {
    // Arrange
    const { wrapped, applyMutation } = await setup({ seconds: 30 });

    // Act
    await wrapped.applyMutation(delta);
    jest.advanceTimersByTime(10_000);
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(20_000);
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(10_000);
    await wrapped.applyMutation(full);

    // Assert: expiry is measured from the full at 10s, not the delta at 0s.
    expect(applyMutation).toHaveBeenNthCalledWith(1, delta);
    expect(applyMutation.mock.calls.map(([mutation]) => mutation.type)).toEqual(
      ['delta', 'full', 'delta', 'full'],
    );
  });

  it('keeps the first full due after catalog rejection until a full succeeds', async () => {
    // Arrange
    const { wrapped, applyMutation } = await setup({ seconds: 30 });
    const failure = new Error('Catalog write failed');
    applyMutation.mockRejectedValueOnce(failure);

    // Act
    const rejected = await wrapped.applyMutation(full).catch(error => error);
    jest.advanceTimersByTime(10_000);
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(20_000);
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(10_000);
    await wrapped.applyMutation(full);

    // Assert: only the successful full at 10s starts the interval.
    expect(rejected).toBe(failure);
    expect(applyMutation.mock.calls.map(([mutation]) => mutation.type)).toEqual(
      ['full', 'full', 'delta', 'full'],
    );
  });

  it('does not reset an existing interval when a due full is rejected', async () => {
    // Arrange
    const { wrapped, applyMutation } = await setup({ seconds: 30 });
    await wrapped.applyMutation(full);
    const failure = new Error('Catalog write failed');
    applyMutation.mockRejectedValueOnce(failure);

    // Act
    jest.advanceTimersByTime(30_000);
    const rejected = await wrapped.applyMutation(full).catch(error => error);
    jest.advanceTimersByTime(1_000);
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(1_000);
    await wrapped.applyMutation(full);

    // Assert: the failed full remains due; a successful retry resets it.
    expect(rejected).toBe(failure);
    expect(applyMutation.mock.calls.map(([mutation]) => mutation.type)).toEqual(
      ['full', 'full', 'full', 'delta'],
    );
  });

  it('resets the interval after a successful fallback full when history reads fail', async () => {
    // Arrange
    const { wrapped, applyMutation, store } = await setup({ seconds: 30 });
    await wrapped.applyMutation(full);
    jest
      .spyOn(store, 'loadCurrentEtags')
      .mockRejectedValueOnce(new Error('History read failed'));

    // Act: the fallback full at 40s must reset the expired interval.
    jest.advanceTimersByTime(40_000);
    await wrapped.applyMutation(full);
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(29_999);
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(1);
    await wrapped.applyMutation(full);

    // Assert: recovered reads convert until exactly 30s after the fallback.
    expect(applyMutation).toHaveBeenNthCalledWith(2, full);
    expect(applyMutation.mock.calls.map(([mutation]) => mutation.type)).toEqual(
      ['full', 'full', 'delta', 'delta', 'full'],
    );
  });

  it('keeps a full due when the fallback catalog write is rejected', async () => {
    // Arrange
    const { wrapped, applyMutation, store } = await setup({ seconds: 30 });
    await wrapped.applyMutation(full);
    jest
      .spyOn(store, 'loadCurrentEtags')
      .mockRejectedValueOnce(new Error('History read failed'));
    const failure = new Error('Catalog write failed');
    applyMutation.mockRejectedValueOnce(failure);

    // Act
    jest.advanceTimersByTime(30_000);
    const rejected = await wrapped.applyMutation(full).catch(error => error);
    jest.advanceTimersByTime(1_000);
    await wrapped.applyMutation(full);
    await wrapped.applyMutation(full);

    // Assert: a failed fallback does not postpone the next successful full.
    expect(rejected).toBe(failure);
    expect(applyMutation.mock.calls.map(([mutation]) => mutation.type)).toEqual(
      ['full', 'full', 'full', 'delta'],
    );
  });

  it('converts the first full with persisted history when no interval is configured', async () => {
    // Arrange
    const { wrapped, applyMutation } = await setup();

    // Act
    await wrapped.applyMutation(full);
    jest.advanceTimersByTime(30_000);
    await wrapped.applyMutation(full);

    // Assert: restarting alone does not opt into periodic full forwarding.
    expect(applyMutation.mock.calls.map(([mutation]) => mutation.type)).toEqual(
      ['delta', 'delta'],
    );
  });
});
