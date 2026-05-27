/**
 * Unit Tests — Config validation
 *
 * Tests the zod-based config loader with various env var combinations.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadConfig } from '../config.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function setEnv(overrides: Record<string, string> = {}): void {
  const defaults: Record<string, string> = {
    FMG_HOST: 'https://fmg.example.com',
    FMG_API_TOKEN: 'test-token',
    ...overrides,
  };

  for (const [key, value] of Object.entries(defaults)) {
    vi.stubEnv(key, value);
  }
}

describe('loadConfig', () => {
  it('loads valid minimal config with defaults', () => {
    setEnv();

    const config = loadConfig();

    expect(config.fmgHost).toBe('https://fmg.example.com');
    expect(config.fmgPort).toBe(443);
    expect(config.fmgApiToken).toBe('test-token');
    expect(config.fmgVerifySsl).toBe(true);
    expect(config.fmgApiVersion).toBe('7.6');
    expect(config.mcpTransport).toBe('stdio');
    expect(config.mcpHttpPort).toBe(8000);
    expect(config.mcpApiKey).toBeUndefined();
    expect(config.mcpTokenPassthrough).toBe(false);
  });

  it('loads full config with all overrides', () => {
    setEnv({
      FMG_PORT: '8443',
      FMG_VERIFY_SSL: 'false',
      FMG_API_VERSION: '7.4',
      MCP_TRANSPORT: 'http',
      MCP_HTTP_PORT: '9000',
    });

    const config = loadConfig();

    expect(config.fmgPort).toBe(8443);
    expect(config.fmgVerifySsl).toBe(false);
    expect(config.fmgApiVersion).toBe('7.4');
    expect(config.mcpTransport).toBe('http');
    expect(config.mcpHttpPort).toBe(9000);
  });

  it('throws on missing FMG_HOST', () => {
    vi.stubEnv('FMG_API_TOKEN', 'test-token');
    // FMG_HOST not set

    expect(() => loadConfig()).toThrow('Configuration validation failed');
  });

  it('throws on missing FMG_API_TOKEN', () => {
    vi.stubEnv('FMG_HOST', 'https://fmg.example.com');
    // FMG_API_TOKEN not set

    expect(() => loadConfig()).toThrow('Configuration validation failed');
  });

  it('throws on invalid FMG_HOST (not a URL)', () => {
    setEnv({ FMG_HOST: 'not-a-url' });

    expect(() => loadConfig()).toThrow('Configuration validation failed');
  });

  it('throws on invalid FMG_API_VERSION', () => {
    setEnv({ FMG_API_VERSION: '6.0' });

    expect(() => loadConfig()).toThrow('Configuration validation failed');
  });

  it('throws on invalid MCP_TRANSPORT', () => {
    setEnv({ MCP_TRANSPORT: 'grpc' });

    expect(() => loadConfig()).toThrow('Configuration validation failed');
  });

  it('reads MCP_API_KEY and MCP_TOKEN_PASSTHROUGH', () => {
    setEnv({
      MCP_API_KEY: 'my-mcp-bearer-key',
      MCP_TOKEN_PASSTHROUGH: 'true',
    });

    const config = loadConfig();

    expect(config.mcpApiKey).toBe('my-mcp-bearer-key');
    expect(config.mcpTokenPassthrough).toBe(true);
  });

  it('MCP_TOKEN_PASSTHROUGH defaults to false and rejects non-boolean strings', () => {
    setEnv({ MCP_TOKEN_PASSTHROUGH: 'yes' });
    expect(() => loadConfig()).toThrow('Configuration validation failed');
  });

  it('rejects an empty MCP_API_KEY', () => {
    setEnv({ MCP_API_KEY: '' });
    expect(() => loadConfig()).toThrow('Configuration validation failed');
  });
});
