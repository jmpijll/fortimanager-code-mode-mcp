/**
 * TLS Tests — FmgClient against a local HTTPS server with a self-signed cert
 *
 * The certificate is generated at test time (no committed keys). Covers the
 * FMG_VERIFY_SSL=false bypass, the rejection when verification stays on, and
 * per-request token passthrough over the same TLS path.
 */

import { createServer, type Server } from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FmgClient } from '../client/fmg-client.js';
import { FmgTransportError, type FmgClientConfig } from '../client/types.js';
import { makeSuccessResponse } from './fixtures/index.js';
import { generateSelfSignedCert } from './fixtures/self-signed-cert.js';

const API_TOKEN = 'test-api-token-12345';
const STATUS_DATA = { Version: '7.6.5', Hostname: 'fmg-tls' };

interface ReceivedRequest {
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

const received: ReceivedRequest[] = [];
let key: string;
let cert: string;
let server: Server;
let port: number;

beforeAll(async () => {
  ({ key, cert } = generateSelfSignedCert());

  server = createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      received.push({ url: req.url, authorization: req.headers.authorization, body });

      const id =
        typeof (body as { id?: unknown }).id === 'number' ? (body as { id: number }).id : 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(makeSuccessResponse(id, '/sys/status', STATUS_DATA)));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
});

function makeClient(verifySsl: boolean): FmgClient {
  const config: FmgClientConfig = {
    host: 'https://127.0.0.1',
    port,
    apiToken: API_TOKEN,
    verifySsl,
  };
  return new FmgClient(config);
}

describe('generated self-signed certificate', () => {
  it('parses as a self-signed CA certificate covering 127.0.0.1', () => {
    const x509 = new X509Certificate(cert);

    expect(x509.subject).toContain('CN=localhost');
    expect(x509.issuer).toContain('CN=localhost');
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.subjectAltName).toContain('IP Address:127.0.0.1');
  });
});

describe('FmgClient over TLS', () => {
  it('completes a JSON-RPC call with verifySsl=false', async () => {
    const client = makeClient(false);

    const result = await client.get<typeof STATUS_DATA>('/sys/status');

    expect(result).toEqual(STATUS_DATA);

    const last = received[received.length - 1]!;
    expect(last.url).toBe('/jsonrpc');
    expect(last.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(last.body).toMatchObject({ method: 'get', params: [{ url: '/sys/status' }] });
  });

  it('rejects the self-signed certificate with verifySsl=true', async () => {
    const client = makeClient(true);

    let error: unknown;
    try {
      await client.get('/sys/status');
    } catch (err: unknown) {
      error = err;
    }

    expect(error).toBeInstanceOf(FmgTransportError);
    expect((error as Error).message).toMatch(/self-signed certificate/i);
  });

  it('sends the tokenOverride Authorization header over TLS', async () => {
    const client = makeClient(false);

    await client.rawRequest('get', [{ url: '/sys/status' }], { tokenOverride: 'tenant-b-token' });

    const last = received[received.length - 1]!;
    expect(last.authorization).toBe('Bearer tenant-b-token');
  });
});
