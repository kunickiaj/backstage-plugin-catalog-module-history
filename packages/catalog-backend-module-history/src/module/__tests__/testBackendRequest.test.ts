import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request, { testBackendUrl } from '../__testUtils__/testBackendRequest';

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

describe('testBackendRequest', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        server =>
          new Promise(resolve => {
            server.close(resolve);
          }),
      ),
    );
  });

  it('reaches a wildcard server that shares its port with a 127.0.0.1 listener', async () => {
    // Arrange: an unrelated IPv4 loopback listener owns the port first.
    const other = createServer((_, res) => {
      res.statusCode = 501;
      res.end('other');
    });
    servers.push(other);
    await listen(other, 0, '127.0.0.1');
    const { port } = other.address() as AddressInfo;
    const ours = createServer((_, res) => res.end('ours'));
    servers.push(ours);
    // Same call shape as Backstage's test backend.
    const bindError = await listen(ours, port, '').then(
      () => undefined,
      (error: NodeJS.ErrnoException) => error,
    );
    if (bindError?.code === 'EADDRINUSE') {
      // Linux refuses the overlapping bind, so the collision cannot occur.
      servers.pop();
      return;
    }
    if (bindError) throw bindError;

    // Act
    const response = await request(ours).get('/');

    // Assert
    expect(response.status).toBe(200);
    expect(response.text).toBe('ours');
  });

  it('uses the IPv4 loopback for a server bound to an IPv4 address', async () => {
    // Arrange
    const server = createServer((_, res) => res.end());
    servers.push(server);
    await listen(server, 0, '127.0.0.1');
    const { port } = server.address() as AddressInfo;
    // Act / Assert
    expect(testBackendUrl(server)).toBe(`http://127.0.0.1:${port}`);
  });

  it('rejects a server that is not listening', () => {
    expect(() => testBackendUrl(createServer())).toThrow(/not listening/);
  });
});
