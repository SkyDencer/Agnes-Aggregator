import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root = parent of src/ (this file lives in src/).
const DOT_ENV_PATH = join(fileURLToPath(new URL('..', import.meta.url)), '.env');

// Minimal .env loader: one KEY=VALUE per line, '#' comments and blank lines
// ignored, surrounding quotes stripped. Real environment variables always
// win — .env only fills in names that are not already set.
function loadDotEnvFile() {
  let content;
  try {
    content = readFileSync(DOT_ENV_PATH, 'utf8');
  } catch {
    return; // no .env file — rely on process.env alone
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig() {
  loadDotEnvFile();
  return {
    port: Number(process.env.PORT ?? 7000),
    host: process.env.HOST ?? '127.0.0.1',
    apiBasePath: process.env.API_BASE_PATH ?? '/api/v1',
    agnesBaseUrl: process.env.AGNES_BASE_URL ?? 'https://apihub.agnes-ai.com/v1',
    agnesApiKey: process.env.AGNES_API_KEY ?? '',
    // Phase 1 additions
    masterKey: process.env.MASTER_KEY ?? '',
    keysFile: process.env.KEYS_FILE ?? './data/keys.json',
    cooldownSeconds: Number(process.env.COOLDOWN_SECONDS ?? 60),
    maxConsecutiveFailures: Number(process.env.MAX_CONSECUTIVE_FAILURES ?? 3),
    upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 60000),
  };
}
