// Client-half contract tests.
//
// The defect under test: the composer switch read state by executing
// `/unattended status` through the Commands remote, and the executor logs every
// resolved command as `command/run`/`command/done` — a pair the transcript renders
// as a visible row. Every focus refresh therefore left a JSON blob at the tail of
// the conversation. These tests pin the two halves of the fix:
//
//   1. a status read is one authenticated GET and never reaches the command
//      executor, so it cannot write a log row;
//   2. the command-row renderer draws one compact line for a real toggle and
//      nothing for a status row, including the rows already recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src/client.js'), 'utf8');

/** Minimal React stand-in: the client only needs element creation plus hooks. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  memo: component => component,
  useReducer: (reducer, initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useState: initial => [initial, () => {}],
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useEffect: () => {},
  useSyncExternalStore: () => ({}),
  Fragment: 'fragment',
};

/**
 * Evaluate the bundle against a recording Host: `__ModuleLoader__` captures the
 * module, and every slot registration is collected for direct invocation.
 */
function mount({ fetchImpl, execute } = {}) {
  const captured = { module: undefined };
  const slots = [];
  const localeDisposers = [];
  const calls = { fetch: [], execute: [] };
  const globalWindow = {
    __ModuleLoader__: { load: ({ factory }) => { captured.module = factory(name => {
      if (name === 'react') return React;
      throw new Error(`unexpected require ${name}`);
    }); } },
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:61669' },
  };
  const documentStub = { visibilityState: 'visible' };
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = globalWindow;
  globalThis.document = documentStub;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.fetch.push([String(url), init]);
    return fetchImpl(String(url), init);
  };
  try {
    new Function('window', 'fetch', 'document', source)(globalWindow, globalThis.fetch, documentStub);
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previousFetch;
  }

  const ctx = {
    locale: {
      register(_ns, _dict) { return () => {}; },
      subscribe: () => () => {},
      getSnapshot: () => ({ locale: 'zh' }),
      bind: () => key => key,
    },
    slots: {
      inject(_key, callback) { const dispose = callback(); return () => dispose?.(); },
      register(_options, component) {
        const dispose = () => {};
        slots.push({ options: _options, component, dispose });
        return dispose;
      },
    },
    remote: { commands: { execute: async (...args) => { calls.execute.push(args); return execute(...args); } } },
    effect: () => () => {},
  };
  captured.module.apply(ctx);
  return { module: captured.module, slots, calls, ctx, localeDisposers };
}

const state = { enabled: false, revision: 3, phase: 'clarifying', lastError: '', sessionId: 'session-1' };
const okFetch = async () => new Response(JSON.stringify({ ok: true, state }), {
  status: 200, headers: { 'content-type': 'application/json' },
});
const okExecute = async () => ({ ok: true, value: { commandId: 'cmd-1', result: { kind: 'success', text: JSON.stringify({ ...state, enabled: true, revision: 4 }) } } });

test('a status read is one authenticated GET and never a command execution', async () => {
  const mounted = mount({ fetchImpl: okFetch, execute: okExecute });
  const read = await mounted.module.api.readState(state.sessionId);
  assert.equal(read.enabled, false);
  assert.equal(mounted.calls.execute.length, 0, 'the status read must not execute a command');
  assert.equal(mounted.calls.fetch.length, 1);
  const [url, init] = mounted.calls.fetch[0];
  assert.equal(url, `api/unattended.status?sessionId=${state.sessionId}`);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'include', 'the browser cookie is the admission for the exact route');
});

test('a status read surfaces the Host refusal instead of inventing state', async () => {
  const mounted = mount({
    // A Host that mounted the route but has no such session answers with a JSON
    // refusal, not an empty body: that is a refusal, never a reason to fall back.
    fetchImpl: async () => new Response('{"ok":false,"error":"Session unavailable"}', {
      status: 404, headers: { 'content-type': 'application/json' },
    }),
    execute: okExecute,
  });
  await assert.rejects(() => mounted.module.api.readState('session-1'), /404/);
  assert.equal(mounted.calls.execute.length, 0, 'a refusal must not degrade into the logging legacy read');
});

test('a Host without the route degrades to the legacy read once and stays there', async () => {
  const mounted = mount({
    // An old Host has no route at all: the carrier answers a plain 404 with no body.
    fetchImpl: async () => new Response(null, { status: 404 }),
    execute: okExecute,
  });
  const read = await mounted.module.api.readState('session-1');
  assert.equal(read.enabled, true, 'the switch still works before the Host is reloaded');
  assert.equal(mounted.calls.fetch.length, 1);
  assert.deepEqual(mounted.calls.execute[0].slice(0, 2), ['session-1', '/unattended status']);
  assert.equal(mounted.module.api.statusRoute(), 'missing');
  // Subsequent reads skip the probe: no repeated 404 round trip.
  await mounted.module.api.readState('session-1');
  assert.equal(mounted.calls.fetch.length, 1, 'the missing route is probed exactly once');
  assert.equal(mounted.calls.execute.length, 2);
});

test('toggling is still a human command, so the log keeps an audit trail', async () => {
  const mounted = mount({ fetchImpl: okFetch, execute: okExecute });
  const next = await mounted.module.api.setEnabled('session-1', true, 3);
  assert.equal(next.enabled, true);
  assert.equal(mounted.calls.fetch.length, 0, 'a state change must not use the read route');
  assert.deepEqual(mounted.calls.execute[0].slice(0, 2), ['session-1', '/unattended on 3']);
});

test('the command-row renderer hides status rows and compacts a toggle', () => {
  const mounted = mount({ fetchImpl: okFetch, execute: okExecute });
  const describe = mounted.module.api.describeRow;
  // Historical rows recorded before this fix: the JSON payload is exactly what the
  // user saw at the tail of the conversation.
  assert.equal(describe({ args: ' status', outcome: { kind: 'success', text: '{"sessionId":"s","enabled":false}' } }), null);
  assert.equal(describe({ args: '', outcome: { kind: 'success', text: '{}' } }), null);
  assert.equal(describe({ args: null, outcome: null }), null);
  assert.deepEqual(describe({ args: ' on 2', outcome: { kind: 'success', text: '{}' } }),
    { tone: 'on', text: 'rowOn' });
  assert.deepEqual(describe({ args: ' off 3', outcome: { kind: 'success', text: '{}' } }),
    { tone: 'off', text: 'rowOff' });
  assert.deepEqual(describe({ args: ' on 2', outcome: null }), { tone: 'busy', text: 'rowBusy' });
  const failed = describe({ args: ' on 2', outcome: { kind: 'error', text: 'stale revision' } });
  assert.equal(failed.tone, 'error');
  assert.match(failed.text, /stale revision/);
});

test('the client registers both its composer switch and its command-row cell', () => {
  const mounted = mount({ fetchImpl: okFetch, execute: okExecute });
  const names = mounted.slots.map(entry => entry.options.name);
  assert.ok(names.includes('conversation.input.left'), `slots: ${names.join(', ')}`);
  assert.ok(names.includes('conversation.chat.commandview'), `slots: ${names.join(', ')}`);
  const row = mounted.slots.find(entry => entry.options.name === 'conversation.chat.commandview');
  assert.equal(row.options.key, 'unattended', 'the cell must own the /unattended command name');
});

test('the composer component actually reads status through the GET route on mount', async () => {
  const mounted = mount({ fetchImpl: okFetch, execute: okExecute });
  const toggleSlot = mounted.slots.find(entry => entry.options.name === 'conversation.input.left');
  // The component is a function component; render it with an inert hook runtime.
  const rendered = toggleSlot.component({ sessionId: 'session-1' });
  assert.ok(rendered, 'the switch must render');
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(mounted.calls.execute.length, 0, 'mounting the switch must not execute a command');
});
