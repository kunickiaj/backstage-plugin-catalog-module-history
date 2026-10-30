import { knex, type Knex } from 'knex';
import { createProviderCoordinationDatabase } from '../providerCoordinationDatabase';

jest.mock('knex', () => ({ knex: jest.fn() }));

describe('createProviderCoordinationDatabase', () => {
  it('preserves dynamic credentials, SSL, schema, and setup hooks without changing the source config', () => {
    // Arrange
    const connection = jest.fn(async () => ({
      host: 'synthetic',
      ssl: { rejectUnauthorized: true },
    }));
    const afterCreate = jest.fn();
    const config = {
      client: 'pg',
      connection,
      searchPath: ['custom_history', 'public'],
      acquireConnectionTimeout: 1234,
      pool: { min: 1, max: 1, afterCreate, idleTimeoutMillis: 4321 },
    };
    const db = { client: { config } } as unknown as Knex;
    const dedicated = {} as Knex;
    jest.mocked(knex).mockReturnValueOnce(dedicated);
    // Act
    const result = createProviderCoordinationDatabase(db);
    // Assert
    expect(result).toBe(dedicated);
    expect(knex).toHaveBeenLastCalledWith({
      ...config,
      acquireConnectionTimeout: 5000,
      pool: {
        ...config.pool,
        min: 0,
        max: 1,
        acquireTimeoutMillis: 5000,
        propagateCreateError: true,
      },
    });
    const passed = jest.mocked(knex).mock.calls.at(-1)![0] as Knex.Config;
    expect(passed.connection).toBe(connection);
    expect(passed.pool!.afterCreate).toBe(afterCreate);
    expect(config.pool).toEqual({
      min: 1,
      max: 1,
      afterCreate,
      idleTimeoutMillis: 4321,
    });
    expect(config.acquireConnectionTimeout).toBe(1234);
    expect(connection).not.toHaveBeenCalled();
  });

  it.each([undefined, 50])(
    'limits the dedicated pool to ten connections when source max is %s',
    max => {
      // Arrange
      const db = {
        client: { config: { client: 'pg', pool: { max } } },
      } as unknown as Knex;
      // Act
      createProviderCoordinationDatabase(db);
      // Assert
      expect(knex).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pool: expect.objectContaining({
            min: 0,
            max: 10,
            acquireTimeoutMillis: 5000,
            propagateCreateError: true,
          }),
        }),
      );
    },
  );

  it('propagates pool construction failure without modifying the original database', () => {
    // Arrange
    const config = { client: 'pg', pool: { min: 1, max: 1 } };
    const db = { client: { config } } as unknown as Knex;
    jest.mocked(knex).mockImplementationOnce(() => {
      throw new Error('pool construction failed');
    });
    // Act / Assert
    expect(() => createProviderCoordinationDatabase(db)).toThrow(
      'pool construction failed',
    );
    expect(db.client.config).toBe(config);
    expect(config.pool).toEqual({ min: 1, max: 1 });
  });
});
