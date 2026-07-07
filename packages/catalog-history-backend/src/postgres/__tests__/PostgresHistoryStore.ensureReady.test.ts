import { type Knex } from 'knex';
import { ensureSchema } from '../ensureSchema';
import { PostgresHistoryStore } from '../PostgresHistoryStore';

jest.mock('../ensureSchema', () => ({
  ensureSchema: jest.fn(),
}));

const mockEnsureSchema = ensureSchema as jest.MockedFunction<
  typeof ensureSchema
>;

describe('PostgresHistoryStore.ensureReady', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('retries schema bootstrap after a transient failure', async () => {
    const store = new PostgresHistoryStore({} as Knex);
    mockEnsureSchema
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);

    await expect(store.ensureReady()).rejects.toThrow('db down');
    await expect(store.ensureReady()).resolves.toBeUndefined();

    expect(mockEnsureSchema).toHaveBeenCalledTimes(2);
  });

  it('runs shutdown hooks before destroying an owned database connection', async () => {
    const events: string[] = [];
    const db = {
      destroy: jest.fn(async () => {
        events.push('destroy');
      }),
    } as unknown as Knex;
    const store = new PostgresHistoryStore(db, { ownsDatabase: true });
    store.addShutdownHook(async () => {
      events.push('flush');
    });

    await store.shutdown();
    await store.shutdown();

    expect(events).toEqual(['flush', 'destroy']);
    expect(db.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not destroy Backstage-managed database connections', async () => {
    const db = { destroy: jest.fn() } as unknown as Knex;
    const store = new PostgresHistoryStore(db);

    await store.shutdown();

    expect(db.destroy).not.toHaveBeenCalled();
  });
});
