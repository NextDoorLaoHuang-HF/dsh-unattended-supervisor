#!/usr/bin/env node
// Static preflight for the dsh-unattended-supervisor bundle.
//
// This is a packaging gate, not a behavioural test: it checks the manifest,
// the Cordis patch, the locale resources and the module syntax so a broken
// bundle is caught before `plugin_manager install_bundle` touches the profile.
// Behaviour lives in test/*.test.js.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

const fail = message => { failures.push(message); };
const note = message => { notes.push(message); };
const readJson = relative => JSON.parse(readFileSync(join(root, relative), 'utf8'));

/* --------------------------------------------------------------- manifest */

let manifest;
try { manifest = readJson('package.json'); }
catch (error) { fail(`package.json is not readable JSON: ${error.message}`); }

if (manifest) {
  for (const field of ['name', 'version', 'type', 'main', 'exports', 'files']) {
    if (manifest[field] === undefined) fail(`package.json is missing "${field}"`);
  }
  if (manifest.name !== 'dsh-unattended-supervisor') fail(`unexpected package name: ${manifest.name}`);
  if (manifest.type !== 'module') fail('package.json must declare "type": "module"');
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch must point at ./cordis.patch.yml');
  if (manifest.dsh?.client?.platform !== 'web') fail('dsh.client.platform must be "web"');

  // Every runtime file must be reachable through "exports"; every entry in
  // "files" must exist, because a packed install ships exactly that list.
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const file = typeof target === 'string' ? target : target?.default;
    if (typeof file !== 'string') { fail(`exports["${subpath}"] has no string target`); continue; }
    if (file.includes('*')) continue; // wildcard exports are checked by directory below
    if (!existsSync(join(root, file))) fail(`exports["${subpath}"] points at a missing file: ${file}`);
  }
  for (const entry of manifest.files ?? []) {
    if (entry.includes('*')) {
      const dir = join(root, entry.slice(0, entry.indexOf('*')).replace(/\/$/, ''));
      if (!existsSync(dir)) fail(`files entry has no directory: ${entry}`);
      continue;
    }
    if (!existsSync(join(root, entry))) fail(`files entry is missing on disk: ${entry}`);
  }
  // The bundle patch and every locale file are display/runtime essentials.
  for (const required of ['cordis.patch.yml', 'locale/en.json', 'locale/zh.json']) {
    if (!(manifest.files ?? []).some(entry => entry === required || (entry.includes('*') && required.startsWith(entry.slice(0, entry.indexOf('*')))))) {
      fail(`files does not ship ${required}`);
    }
  }
  // The icon is optional for a Host-only bundle; when declared it must exist.
  const hasIconExport = Object.hasOwn(manifest.exports ?? {}, './icon') || typeof manifest.icon === 'string';
  if (hasIconExport) {
    const iconPath = typeof manifest.icon === 'string' ? manifest.icon : manifest.exports['./icon'];
    if (typeof iconPath !== 'string' || !existsSync(join(root, iconPath))) fail('an icon is exported but the file is missing');
    else if (!/\.(svg|png|jpe?g|webp)$/i.test(iconPath)) fail(`icon must be svg/png/jpeg/webp, got ${iconPath}`);
  }
}

/* ------------------------------------------------------------------ patch */

const patchPath = join(root, 'cordis.patch.yml');
if (!existsSync(patchPath)) fail('cordis.patch.yml is missing');
else {
  const patch = readFileSync(patchPath, 'utf8');
  if (!patch.includes('insert:')) fail('cordis.patch.yml has no insert list');
  if (manifest && !patch.includes(manifest.name)) fail(`cordis.patch.yml never names ${manifest.name}`);
  // The bundle inserts one Host row; it must not override or disable shipped rows.
  // Strip whole-line comments before inspecting the entry list, so a header comment
  // cannot disguise an id-targeted override as an insert list.
  const entries = patch.split('\n').filter(line => !/^\s*#/.test(line)).join('\n').trim();
  if (!entries.startsWith('- insert:')) {
    note('cordis.patch.yml starts with an id-targeted entry; confirm that override is intentional');
  }
}

/* ---------------------------------------------------------------- locales */

for (const locale of ['en', 'zh']) {
  const relative = `locale/${locale}.json`;
  if (!existsSync(join(root, relative))) { fail(`${relative} is missing`); continue; }
  try {
    const parsed = readJson(relative);
    if (typeof parsed.meta?.title !== 'string' || !parsed.meta.title.trim()) fail(`${relative} has no meta.title`);
    if (typeof parsed.meta?.description !== 'string' || !parsed.meta.description.trim()) fail(`${relative} has no meta.description`);
  } catch (error) { fail(`${relative} is not readable JSON: ${error.message}`); }
}

/* ---------------------------------------------------------------- modules */

for (const file of ['src/index.js', 'src/client.js', 'src/controller.js', 'src/engine.js', 'src/mail.js']) {
  if (!existsSync(join(root, file))) { fail(`${file} is missing`); continue; }
  try { execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' }); }
  catch (error) { fail(`${file} does not parse: ${String(error.stderr || error.message).trim().split('\n')[0]}`); }
}

/* ------------------------------------------------------- engine purity ---- */

// engine.js is deliberately dependency-free: it must not import anything.
const engine = existsSync(join(root, 'src/engine.js')) ? readFileSync(join(root, 'src/engine.js'), 'utf8') : '';
if (engine && /^\s*import\s/m.test(engine)) fail('src/engine.js must not import any module (pure state engine)');

/* ------------------------------------------------------------- report ----- */

for (const message of notes) process.stdout.write(`note: ${message}\n`);
if (failures.length) {
  for (const message of failures) process.stderr.write(`FAIL ${message}\n`);
  process.stderr.write(`\ncheck failed: ${failures.length} problem(s)\n`);
  process.exit(1);
}
process.stdout.write(`check ok: ${manifest?.name}@${manifest?.version}\n`);
