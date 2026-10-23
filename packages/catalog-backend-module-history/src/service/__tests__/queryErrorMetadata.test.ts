import { queryErrorMetadata } from '../queryErrorMetadata';

const frames =
  '    at originalQuery (/synthetic/query.ts:12:3)\n    at originalCaller (/synthetic/caller.ts:24:5)';
const privateMessage =
  'password=synthetic-password token=synthetic-token SELECT * FROM synthetic_private_table';

describe('queryErrorMetadata', () => {
  it.each(['42P01', 'ECONNREFUSED', 'AB', 'A'.repeat(32)])(
    'preserves the original error type, frames, and valid code %s',
    code => {
      // Arrange: changing the display name must not change the constructor type.
      const error = Object.assign(new TypeError(privateMessage), { code });
      error.name = 'QueryFailure';
      error.stack = `${Error.prototype.toString.call(error)}\n${frames}`;

      // Act
      const metadata = queryErrorMetadata(error);

      // Assert: retain call sites, not a newly created sanitizer stack.
      expect(metadata).toEqual({
        errorType: 'TypeError',
        errorCode: code,
        stack: frames,
      });
    },
  );

  it('omits messages, SQL, entity payloads, and nested cause metadata from JSON logs', () => {
    // Arrange
    const error = Object.assign(new Error(privateMessage), {
      code: '42P01',
      cause: new Error('synthetic-cause-secret'),
      entity: { spec: { password: 'synthetic-entity-secret' } },
      sql: 'SELECT synthetic-payload',
    });
    error.stack = `${Error.prototype.toString.call(error)}\n${frames}`;

    // Act
    const serialized = JSON.stringify(queryErrorMetadata(error));

    // Assert: the entire serialized object is safe, not just selected fields.
    expect(JSON.parse(serialized)).toEqual({
      errorType: 'Error',
      errorCode: '42P01',
      stack: frames,
    });
    expect(serialized).not.toMatch(
      /password|token|SELECT|cause|entity|payload/,
    );
  });

  it('strips the complete multiline message including fake stack frames', () => {
    // Arrange: a frame-looking message line is still private message text.
    const error = new Error(
      `${privateMessage}\n    at synthetic-token (/private/message.ts:1:1)\nlast private message line`,
    );
    error.stack = `${Error.prototype.toString.call(error)}\n${frames}`;

    // Act
    const metadata = queryErrorMetadata(error);

    // Assert
    expect(metadata).toEqual({
      errorType: 'Error',
      errorCode: undefined,
      stack: frames,
    });
    expect(JSON.stringify(metadata)).not.toMatch(/private|synthetic-token/);
  });

  it.each([
    ['string', privateMessage],
    ['object', { message: privateMessage, stack: frames, code: '42P01' }],
    ['object', null],
    ['undefined', undefined],
    ['number', 42],
    ['boolean', false],
  ])('returns only typeof metadata for a non-Error %s value', (type, value) => {
    // Arrange
    const thrown = value;

    // Act
    const metadata = queryErrorMetadata(thrown);

    // Assert
    expect(metadata).toEqual({ errorType: type });
  });

  it.each([
    undefined,
    42,
    null,
    {},
    '',
    'A',
    'A'.repeat(33),
    'econnrefused',
    'ERR-CODE',
    '42P01\n',
    '42P01 token=synthetic-token',
  ])('omits malformed error code %p', code => {
    // Arrange
    const error = Object.assign(new Error(privateMessage), { code });
    error.stack = `${Error.prototype.toString.call(error)}\n${frames}`;

    // Act
    const metadata = queryErrorMetadata(error);

    // Assert
    expect(metadata.errorCode).toBeUndefined();
    expect(JSON.parse(JSON.stringify(metadata))).toEqual({
      errorType: 'Error',
      stack: frames,
    });
  });

  it.each([
    undefined,
    '',
    `DifferentError: ${privateMessage}\n${frames}`,
    `Error: other private message\n${frames}`,
    `Error: ${privateMessage} trailing text\n${frames}`,
    `Error: ${privateMessage}`,
    frames,
  ])('omits unknown or absent stack formats (%p)', stack => {
    // Arrange
    const error = new Error(privateMessage);
    error.stack = stack;

    // Act
    const metadata = queryErrorMetadata(error);

    // Assert: never fall back to an unrecognized raw stack.
    expect(JSON.parse(JSON.stringify(metadata))).toEqual({
      errorType: 'Error',
    });
  });

  it('omits a stack when only the first line of a multiline header matches', () => {
    // Arrange
    const error = new Error(`first line\n${privateMessage}`);
    error.stack = `Error: first line\n${frames}`;

    // Act
    const metadata = queryErrorMetadata(error);

    // Assert
    expect(metadata.stack).toBeUndefined();
  });

  it('retains only whitespace-prefixed at frames after the exact header', () => {
    // Arrange
    const error = new Error(privateMessage);
    error.stack = `${Error.prototype.toString.call(error)}\n${frames}\n${privateMessage}\nat unindented-secret\n    attached private payload`;

    // Act
    const metadata = queryErrorMetadata(error);

    // Assert
    expect(metadata.stack).toBe(frames);
  });

  it('omits stacks with no recognized frames after a matching header', () => {
    // Arrange
    const error = new Error(privateMessage);
    error.stack = `${Error.prototype.toString.call(error)}\n${privateMessage}`;

    // Act
    const metadata = queryErrorMetadata(error);

    // Assert
    expect(metadata.stack).toBeUndefined();
  });
});
