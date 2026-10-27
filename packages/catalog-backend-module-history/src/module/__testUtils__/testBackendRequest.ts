import type { AddressInfo } from 'node:net';
import supertest from 'supertest';

type ListeningServer = { address(): AddressInfo | string | null };

/**
 * Returns a base URL that reaches this server and no other process.
 *
 * Backstage's test backend listens on the wildcard address `::`. supertest
 * maps that to `127.0.0.1`, but on macOS another process can listen on
 * `127.0.0.1` with the same port, and the kernel then delivers the request to
 * that process. Tests saw its answers as stray 401, 501, or socket hang-up
 * failures. Connecting over the family the server bound avoids the overlap.
 */
export function testBackendUrl(server: ListeningServer): string {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error(`Test server is not listening on TCP: ${address}`);
  }
  // Node falls back to 0.0.0.0 when IPv6 is unavailable.
  const host = address.family === 'IPv6' ? '[::1]' : '127.0.0.1';
  return `http://${host}:${address.port}`;
}

/** supertest for a listening test backend, using {@link testBackendUrl}. */
export default function request(server: ListeningServer) {
  return supertest(testBackendUrl(server));
}
