/**
 * Minimal self-signed X.509 certificate generator for TLS tests.
 *
 * Node has no built-in certificate generation API, so this hand-builds the
 * DER structure (RFC 5280) and signs it with node:crypto — no external
 * dependencies and no committed private keys.
 */

import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';

type Bytes = Uint8Array;

const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  oid: 0x06,
  utf8String: 0x0c,
  utcTime: 0x17,
  sequence: 0x30,
  set: 0x31,
  context0: 0xa0,
  context3: 0xa3,
  dnsName: 0x82,
  ipAddress: 0x87,
} as const;

/** ecdsa-with-SHA256, parameters absent per RFC 5758 */
const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';

// ─── DER Primitives ─────────────────────────────────────────────────

function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeLength(length: number): Bytes {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, content: Bytes): Bytes {
  return concat(Uint8Array.of(tag), encodeLength(content.length), content);
}

function integer(value: number): Bytes {
  const bytes: number[] = [];
  for (let n = value; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  if (bytes.length === 0) bytes.push(0);
  if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0);
  return tlv(TAG.integer, Uint8Array.from(bytes));
}

function randomSerial(): Bytes {
  const raw = Uint8Array.from(randomBytes(8));
  raw[0] = (raw[0]! & 0x7f) | 0x01;
  return tlv(TAG.integer, raw);
}

function oid(dotted: string): Bytes {
  const parts = dotted.split('.').map(Number);
  const body: number[] = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunks: number[] = [];
    let n = part;
    do {
      chunks.unshift(n & 0x7f);
      n >>= 7;
    } while (n > 0);
    for (let i = 0; i < chunks.length - 1; i++) chunks[i] = chunks[i]! | 0x80;
    body.push(...chunks);
  }
  return tlv(TAG.oid, Uint8Array.from(body));
}

function utf8String(value: string): Bytes {
  return tlv(TAG.utf8String, new TextEncoder().encode(value));
}

function utcTime(date: Date): Bytes {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}` +
    `${pad(date.getUTCSeconds())}Z`;
  return tlv(TAG.utcTime, new TextEncoder().encode(stamp));
}

function boolean(value: boolean): Bytes {
  return tlv(TAG.boolean, Uint8Array.of(value ? 0xff : 0x00));
}

function bitString(bytes: Bytes, unusedBits = 0): Bytes {
  return tlv(TAG.bitString, concat(Uint8Array.of(unusedBits), bytes));
}

function octetString(bytes: Bytes): Bytes {
  return tlv(TAG.octetString, bytes);
}

function sequence(...items: Bytes[]): Bytes {
  return tlv(TAG.sequence, concat(...items));
}

function extension(extOid: string, critical: boolean, value: Bytes): Bytes {
  return sequence(oid(extOid), ...(critical ? [boolean(true)] : []), octetString(value));
}

/** X.501 Name with a single CN attribute: SEQUENCE { SET { SEQUENCE { OID, UTF8String } } } */
function commonName(cn: string): Bytes {
  return sequence(tlv(TAG.set, sequence(oid('2.5.4.3'), utf8String(cn))));
}

function derToPem(der: Bytes, label: string): string {
  const base64 = Buffer.from(der).toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// ─── Certificate Generation ─────────────────────────────────────────

export interface SelfSignedCert {
  /** Private key, PKCS#8 PEM */
  key: string;
  /** Certificate, PEM */
  cert: string;
}

/**
 * Generate a fresh EC (P-256) self-signed certificate that is its own CA.
 * Valid from one hour ago for 24 hours, with SANs for `localhost` and
 * `127.0.0.1` so clients can connect over either name.
 */
export function generateSelfSignedCert(cn = 'localhost'): SelfSignedCert {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const now = Date.now();
  const validity = sequence(
    utcTime(new Date(now - 60 * 60 * 1000)),
    utcTime(new Date(now + 24 * 60 * 60 * 1000)),
  );

  const extensions = sequence(
    extension('2.5.29.19', true, sequence(boolean(true))), // basicConstraints: CA:TRUE
    extension('2.5.29.15', true, bitString(Uint8Array.of(0x84), 2)), // keyUsage: digitalSignature + keyCertSign
    extension(
      '2.5.29.17',
      false,
      sequence(
        tlv(TAG.dnsName, new TextEncoder().encode(cn)),
        tlv(TAG.ipAddress, Uint8Array.of(127, 0, 0, 1)),
      ),
    ),
  );

  const tbsCertificate = sequence(
    tlv(TAG.context0, integer(2)), // version: v3
    randomSerial(),
    algorithm,
    commonName(cn), // issuer
    validity,
    commonName(cn), // subject
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(TAG.context3, extensions),
  );

  const signature = sign('sha256', tbsCertificate, privateKey);
  const certificate = sequence(tbsCertificate, algorithm, bitString(signature));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: derToPem(certificate, 'CERTIFICATE'),
  };
}
