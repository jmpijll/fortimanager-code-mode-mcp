import { readFileSync } from 'node:fs';

// src/ and dist/ are both direct children of the package root.
function readPackageVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Preserve startup when package metadata is unavailable.
  }
  return '0.0.0-unknown';
}

export const SERVER_VERSION = readPackageVersion();
