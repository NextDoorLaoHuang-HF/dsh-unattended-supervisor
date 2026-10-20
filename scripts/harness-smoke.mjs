// Real-runtime mounting test for dsh-unattended-supervisor.
//
// Unit tests exercise the pure engine with stubs. This script instead mounts the
// plugin's own `apply()` on a real Cordis Context against the REAL storage stack
// (storage hub + json backend + domain facility) shipped with this DSH install,
// stubbing only the Host services the plugin reads. It is the check that catches
// packaging-level defects a stub cannot see: the domain name, the per-record key
// alphabet, Config defaults and the registration calls.
//
// Run: node scripts/harness-smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The DSH runtime is resolved from this install, never vendored.
const DSH_MODULES = process.env.DSH_MODULES
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/node_modules'
  ?? '/tmp/dsh-inspect/extracted/dsh/node_modules';

const failures = [];
const check = (label, fn) => {
  try { fn(); process.stdout.write(`  ok   ${label}\n`); }
  catch (error) { failures.push(`${label}: ${error.message}`); process.stdout.write(`  FAIL ${label}: ${error.message}\n`); }
};
const asyncCheck = async (label, fn) => {
  try { await fn(); process.stdout.write(`  ok   ${label}\n`); }
  catch (error) { failures.push(`${label}: ${error.message}`); process.stdout.write(`  FAIL ${label}: ${error.message}\n`); }
};

async function loadReal() {
  const candidates = [
    process.env.DSH_MODULES,
    '/tmp/dsh-inspect/extracted/dsh/node_modules',
    join(process.cwd(), 'node_modules'),
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      const cordis = await import(join(base, '@deepseek-ai/cordis/lib/index.js'));
      const storage = await import(join(base, '@deepseek-ai/dsh-storage/lib/index.js'));
      const json = await import(join(base, '@deepseek-ai/dsh-storage-json/lib/index.js'));
      const domain = await import(join(base, '@deepseek-ai/dsh-storage-domain/lib/index.js'));
      return { base, Context: cordis.Context, storage, json, domain };
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

const real = await loadReal();
if (!real) {
  process.stdout.write('SKIP: no DSH runtime package tree found; set DSH_MODULES to run this check.\n');
  process.exit(0);
}
process.stdout.write(`runtime: ${real.base}\n`);

const { Context, storage, json, domain } = real;
const plugin = await import('../src/index.js');

/* ------------------------------------------------- real storage constants */

check('the plugin domain name satisfies the live UNIT_NAME_RE', () => {
  if (!storage.UNIT_NAME_RE.test(plugin.DOMAIN_NAME)) {
    throw new Error(`${plugin.DOMAIN_NAME} rejected by ${storage.UNIT_NAME_RE}`);
  }
});

await asyncCheck('defineDomain accepts the plugin domain spec', async () => {
  const { z } = await import('zod');
  domain.defineDomain({
    name: plugin.DOMAIN_NAME, version: 1, layout: 'per-record',
    tables: {
      tasks: { valueSchema: z.object({ sessionId: z.string() }).passthrough() },
      outbox: { valueSchema: z.object({ sessionId: z.string() }).passthrough() },
    },
  });
});

/* --------------------------------------------------- real Cordis mounting */

const home = mkdtempSync(join(tmpdir(), 'dsh-us-smoke-'));
const registered = { tools: [], commands: [], provided: [] };

// A Loader row mounts a module's named `apply` with its `inject` list, while Cordis
// itself only accepts a function, a class, or `{ apply }`. Normalise the ESM
// namespace the same way the Loader's module form does, for every package mounted
// here (some ship a default class, others named apply/inject exports).
const rowOf = module => {
  if (typeof module.apply === 'function') return { name: module.name, inject: module.inject, Config: module.Config, apply: module.apply };
  if (typeof module.default === 'function') return module.default;
  throw new Error(`package exports neither an apply function nor a default class: ${Object.keys(module).join(', ')}`);
};

await asyncCheck('apply() mounts on a real Cordis Context with the real storage stack', async () => {
  const ctx = new Context();
  ctx.logger = { info() {}, warn() {}, error() {} };
  ctx.provide('logger', ctx.logger);

  // Host surfaces the plugin reads, stubbed at the service boundary.
  ctx.provide('agents', { get: () => undefined, list: () => [], roots: () => [], isOwnedBy: () => false });
  ctx.provide('commands', { register(definition) { registered.commands.push(definition.name); return () => {}; } });
  ctx.provide('tools', { register(definition) { registered.tools.push(definition.name); return () => {}; } });
  ctx.provide('systemPrompt', { context: () => () => {}, section: () => () => {} });
  ctx.interval = (_fn, ms) => { registered.sweepMs = ms; return () => {}; };
  ctx.provide('timer', {});

  // Real storage: hub -> json backend -> domain facility.
  await ctx.plugin(rowOf(storage), {});
  await ctx.plugin(rowOf(json), { root: home });
  await ctx.plugin(rowOf(domain), { backend: 'json' });

  const fiber = await ctx.plugin(rowOf(plugin), undefined);
  registered.provided.push(typeof ctx.get('unattendedSupervisor'));
  // `fiber.dispose()` runs the effect disposers; `registry.delete(fiber)` resolves a
  // plugin callback (not a fiber) and would silently skip cleanup.
  await fiber.dispose();
  if (ctx.get('unattendedSupervisor') !== undefined) {
    throw new Error('the controller service must be released on unload');
  }
});

check('the plugin registered its three read/record tools', () => {
  const expected = ['unattended_status', 'unattended_checkpoint', 'unattended_request_user'];
  for (const name of expected) {
    if (!registered.tools.includes(name)) throw new Error(`missing tool ${name}; got ${registered.tools.join(', ')}`);
  }
});

check('the plugin registered the human /unattended command', () => {
  if (!registered.commands.includes('unattended')) throw new Error(`commands: ${registered.commands.join(', ')}`);
});

check('an omitted Config row still yields the configured sweep interval', () => {
  if (registered.sweepMs !== 5000) throw new Error(`ctx.interval received ${registered.sweepMs}, expected 5000`);
});

check('the plugin provided its local service for the UI transport', () => {
  if (!registered.provided.includes('object')) throw new Error(`unattendedSupervisor is ${registered.provided.join(',')}`);
});

rmSync(home, { recursive: true, force: true });

if (failures.length) {
  process.stderr.write(`\nharness smoke failed: ${failures.length} problem(s)\n`);
  process.exit(1);
}
process.stdout.write('\nharness smoke ok: the plugin mounts against the real storage stack\n');
