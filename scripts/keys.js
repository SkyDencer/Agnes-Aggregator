#!/usr/bin/env node
// Key pool management CLI (Phase 1). The only key-management interface in
// this phase; the panel UI comes in Phase 3.
//
// Usage:
//   node scripts/keys.js list
//   node scripts/keys.js add <api-key> [--label <label>] [--priority <n>]
//   node scripts/keys.js remove <id>
//   node scripts/keys.js disable <id>
//   node scripts/keys.js enable <id>
//   node scripts/keys.js reset-cooldown <id>
//
// Exit codes: 0 success, 1 user error, 2 internal error.
import { KeyStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';

const MASTER_KEY_RE = /^[0-9a-fA-F]{64}$/;

function fail(message, code) {
  console.error(`[keys] ${message}`);
  process.exit(code);
}

function usage() {
  console.error(
    'Usage: node scripts/keys.js <list|add|remove|disable|enable|reset-cooldown> ...\n' +
      '  list\n' +
      '  add <api-key> [--label <label>] [--priority <n>]\n' +
      '  remove <id> | disable <id> | enable <id> | reset-cooldown <id>\n' +
      'IDs may be full UUIDs or a unique prefix (see list output).'
  );
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command) usage();

  const config = loadConfig(); // loads .env, fills process.env
  if (!MASTER_KEY_RE.test(config.masterKey)) {
    fail(
      'MASTER_KEY is missing or not 64 hex. Generate with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
        'and add it to .env',
      2
    );
  }
  const store = new KeyStore({ filePath: config.keysFile, masterKeyHex: config.masterKey });
  await store.init();

  switch (command) {
    case 'list': {
      const rows = store.list();
      if (rows.length === 0) {
        console.log('No keys in pool. Add one with: node scripts/keys.js add <api-key> --label "..."');
        return;
      }
      const now = Date.now();
      const headers = ['ID', 'Label', 'Status', 'Masked', 'Requests', 'Failures', 'Cooldown'];
      const lines = rows.map((k) => {
        const cooldown =
          k.status === 'cooling_down' && k.cooldown_until && k.cooldown_until > now
            ? `${Math.ceil((k.cooldown_until - now) / 1000)}s`
            : '-';
        // cells aligned positionally with headers
        return [k.id.slice(0, 8) + '…', k.label ?? '-', k.status, k.masked_key, String(k.total_requests), String(k.consecutive_failures), cooldown];
      });
      const widths = headers.map((h, i) => Math.max(h.length, ...lines.map((row) => row[i].length)));
      const render = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
      console.log(render(headers));
      console.log(render(widths.map((w) => '-'.repeat(w))));
      lines.forEach((row) => console.log(render(row)));
      console.log(`(${rows.length} key(s), full IDs in ${config.keysFile})`);
      return;
    }

    case 'add': {
      // positional: api-key; flags: --label, --priority
      let apiKey = null;
      let label = null;
      let priority = 100;
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--label') label = argv[++i];
        else if (a === '--priority') priority = Number(argv[++i]);
        else if (apiKey == null) apiKey = a;
        else fail(`unexpected argument: ${a}`, 1);
      }
      if (!apiKey) fail('add requires an <api-key> argument', 1);
      if (Number.isNaN(priority)) fail('--priority must be a number', 1);
      const added = await store.add({ label: label ?? 'untitled', apiKey, priority });
      // never print the plaintext key
      console.log(`added ${added.id} (label: ${added.label}, status: ${added.status}, masked: ${added.masked_key})`);
      return;
    }

    case 'remove':
    case 'disable':
    case 'enable':
    case 'reset-cooldown': {
      const idArg = argv[1];
      if (!idArg) usage();
      const all = store.list();
      const exact = all.find((k) => k.id === idArg);
      const prefixMatches = all.filter((k) => k.id.startsWith(idArg));
      let target = exact;
      if (!exact) {
        if (prefixMatches.length === 1) target = prefixMatches[0];
        else if (prefixMatches.length > 1) fail(`id prefix "${idArg}" matches ${prefixMatches.length} keys — use the full id`, 1);
        else fail(`key not found: ${idArg}`, 1);
      }
      const id = target.id;
      if (command === 'remove') {
        await store.remove(id);
        console.log(`removed ${id.slice(0, 8)}…`);
      } else if (command === 'disable') {
        await store.updateStatus(id, { status: 'disabled' });
        console.log(`disabled ${id.slice(0, 8)}…`);
      } else if (command === 'enable') {
        await store.updateStatus(id, { status: 'active', cooldown_until: null, consecutive_failures: 0, last_error: null });
        console.log(`enabled ${id.slice(0, 8)}…`);
      } else if (command === 'reset-cooldown') {
        if (target.status !== 'cooling_down') {
          fail(`key ${id.slice(0, 8)}… is not cooling_down (status: ${target.status})`, 1);
        }
        await store.updateStatus(id, { status: 'active', cooldown_until: null, consecutive_failures: 0, last_error: null });
        console.log(`cooldown reset for ${id.slice(0, 8)}…`);
      }
      return;
    }

    default:
      fail(`unknown command: ${command}`, 1);
  }
}

main().catch((err) => {
  console.error(`[keys] internal error: ${err?.message || err}`);
  console.error(err?.stack || '');
  process.exit(2);
});
