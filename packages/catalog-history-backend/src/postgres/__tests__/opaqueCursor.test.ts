import { Buffer } from 'node:buffer';
import { InputError } from '@backstage/errors';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../opaqueCursor';
import {
  decodeProviderSearchCursor,
  providerSearchScope,
} from '../providerSearchCursor';

const options = {
  tag: 'thing',
  scope: 'scope-1',
  fields: ['name', 'id'] as const,
  label: 'thing',
};

function raw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('opaque cursors', () => {
  it('round-trips the anchor fields', () => {
    // Arrange
    const cursor = encodeOpaqueCursor('thing', 'scope-1', {
      name: 'a',
      id: '1',
    });
    // Act / Assert
    expect(decodeOpaqueCursor(cursor, options)).toEqual({ name: 'a', id: '1' });
  });

  it.each([
    [
      'another tag',
      { tag: 'other', version: 1, scope: 'scope-1', name: 'a', id: '1' },
    ],
    [
      'another scope',
      { tag: 'thing', version: 1, scope: 'scope-2', name: 'a', id: '1' },
    ],
    [
      'another version',
      { tag: 'thing', version: 2, scope: 'scope-1', name: 'a', id: '1' },
    ],
    [
      'a missing field',
      { tag: 'thing', version: 1, scope: 'scope-1', name: 'a' },
    ],
    [
      'an extra field',
      {
        tag: 'thing',
        version: 1,
        scope: 'scope-1',
        name: 'a',
        id: '1',
        x: '2',
      },
    ],
    [
      'a non-string field',
      { tag: 'thing', version: 1, scope: 'scope-1', name: 'a', id: 1 },
    ],
    ['an array', ['thing']],
  ])('rejects %s without exposing the cursor', (_, payload) => {
    // Act / Assert
    expect(() => decodeOpaqueCursor(raw(payload), options)).toThrow(
      new InputError('Invalid history thing cursor'),
    );
  });

  it('rejects non-canonical base64url', () => {
    // Arrange: padding makes the same bytes encode differently.
    const cursor = `${encodeOpaqueCursor('thing', 'scope-1', { name: 'a', id: '1' })}=`;
    // Act / Assert
    expect(() => decodeOpaqueCursor(cursor, options)).toThrow(InputError);
  });

  it('still decodes provider cursors issued before this format', () => {
    // Arrange: earlier releases wrote lastName before scope.
    const scope = providerSearchScope({ prefix: 'ex' });
    const legacy = raw({
      tag: 'provider-search',
      version: 1,
      lastName: 'example',
      scope,
    });
    // Act / Assert
    expect(decodeProviderSearchCursor(legacy, scope)).toBe('example');
  });
});
