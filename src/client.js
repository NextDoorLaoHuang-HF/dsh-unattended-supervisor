window.__ModuleLoader__.load({
  id: 'dsh-unattended-supervisor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // Exact Fetch route owned by the Host half. Read-only by construction: the UI
    // switch reads state from it instead of re-entering `/unattended status`, which
    // the commands executor would log as a `command/run`/`command/done` pair.
    const STATUS_ROUTE = 'api/unattended.status';
    const module = {
      name: 'unattended-supervisor-client',
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      // Test seam: the same functions the components call, exposed after mount.
      api: undefined,
      apply(ctx) {
        const disposers = [];
        disposers.push(ctx.locale.register('unattended', {
          zh: { on: '无人值守：开', off: '无人值守：关', loading: '读取状态…', busy: '正在切换…',
            hint: '仅开关无人值守辅助，不会暂停或取消任务、工具和子代理。', refresh: '刷新状态',
            failed: '无法获取状态', unavailable: '当前会话不可用', wait: '待澄清',
            running: '推进中', waiting: '等待中', complete: '已完成',
            rowOn: '无人值守：已开启', rowOff: '无人值守：已关闭', rowBusy: '无人值守：切换中…',
            rowFailed: '无人值守：切换失败' },
          en: { on: 'Unattended: on', off: 'Unattended: off', loading: 'Reading state…', busy: 'Switching…',
            hint: 'Switches unattended assistance only; never pauses or cancels tasks, tools or subagents.', refresh: 'Refresh status',
            failed: 'Cannot read state', unavailable: 'Session unavailable', wait: 'Needs clarification',
            running: 'Running', waiting: 'Waiting', complete: 'Complete',
            rowOn: 'Unattended turned on', rowOff: 'Unattended turned off', rowBusy: 'Unattended: switching…',
            rowFailed: 'Unattended: switch failed' },
        }));
        const t = ctx.locale.bind('unattended');
        const cache = new Map();
        const listeners = new Set();
        let alive = true;
        // Transitional: a Host process that started before this version mounted the
        // route has no read-only transport. Probe once, then stay on the legacy
        // command read (which logs a row per read) and say so, instead of presenting
        // a dead switch. The flag lives with the module, so one probe per page.
        let statusRoute = 'unknown';
        const notify = () => { for (const fn of listeners) fn(); };
        const acceptState = state => {
          if (!state || typeof state.enabled !== 'boolean' || !Number.isSafeInteger(state.revision)) throw new Error(t('failed'));
          return state;
        };
        const remember = (sessionId, state) => {
          if (alive) { cache.set(sessionId, state); notify(); }
          return state;
        };
        // Legacy transport: executes `/unattended status`, which the Commands executor
        // logs as a command lifecycle row. Only reached when the read-only route is
        // absent, i.e. before the Host half of this version is loaded.
        async function legacyRead(sessionId) {
          const response = await ctx.remote.commands.execute(sessionId, '/unattended status', []);
          if (!response.ok) throw new Error(response.error?.message ?? t('failed'));
          const result = response.value?.result;
          if (!result || result.kind !== 'success') throw new Error(result?.text ?? t('unavailable'));
          let parsed;
          try { parsed = JSON.parse(result.text); }
          catch { throw new Error(`${t('failed')}: ${String(result.text).slice(0, 200)}`); }
          return remember(sessionId, acceptState(parsed));
        }
        // Read-only status: one authenticated GET, no command lifecycle, no log row.
        async function readState(sessionId) {
          if (!sessionId) throw new Error(t('unavailable'));
          if (statusRoute === 'missing') return legacyRead(sessionId);
          const query = new URLSearchParams({ sessionId });
          const response = await fetch(`${STATUS_ROUTE}?${query}`, {
            method: 'GET', credentials: 'include', headers: { accept: 'application/json' },
          });
          if (response.status === 404 && statusRoute === 'unknown') {
            const payload = await response.json().catch(() => undefined);
            // A known session the Host refuses is a real refusal; only a plain
            // "route not found" falls back, so a refusal is never mistaken for it.
            if (payload === undefined) { statusRoute = 'missing'; notify(); return legacyRead(sessionId); }
          }
          statusRoute = 'ready';
          if (!response.ok) throw new Error(`${t('failed')} (${response.status})`);
          const payload = await response.json();
          if (!payload || payload.ok !== true) throw new Error(t('failed'));
          return remember(sessionId, acceptState(payload.state));
        }
        // State changes stay human commands: the switch is the only caller, and the
        // recorded lifecycle is the audit trail for who flipped it.
        async function setEnabled(sessionId, enabled, revision) {
          const suffix = revision === undefined ? '' : ` ${revision}`;
          const line = `/unattended ${enabled ? 'on' : 'off'}${suffix}`;
          const response = await ctx.remote.commands.execute(sessionId, line, []);
          if (!response.ok) throw new Error(response.error?.message ?? t('failed'));
          if (response.value === undefined) throw new Error(`${t('unavailable')}: ${line}`);
          const result = response.value.result;
          if (!result || result.kind !== 'success') throw new Error(result?.text ?? t('unavailable'));
          let parsed;
          try { parsed = JSON.parse(result.text); }
          catch { throw new Error(`${t('failed')}: ${String(result.text).slice(0, 200)}`); }
          return remember(sessionId, acceptState(parsed));
        }
        // One compact transcript line for a real toggle, nothing for a status poll.
        // Historical rows are folded from the same events, so this renderer also
        // clears the JSON blobs left in older Sessions.
        function describeRow(node) {
          const args = String(node?.args ?? '').trim();
          const outcome = node?.outcome ?? null;
          const action = args.split(/\s+/)[0] ?? '';
          if (action !== 'on' && action !== 'off') return null;
          if (outcome === null) return { tone: 'busy', text: t('rowBusy') };
          if (outcome.kind === 'error') return { tone: 'error', text: `${t('rowFailed')}${outcome.text ? ` · ${outcome.text}` : ''}` };
          return { tone: action, text: action === 'on' ? t('rowOn') : t('rowOff') };
        }
        function Row({ node }) {
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
          const view = describeRow(node);
          if (view === null) return null;
          const color = view.tone === 'error' ? 'var(--dsw-alias-state-error-primary)'
            : view.tone === 'on' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';
          const dot = view.tone === 'error' ? 'var(--dsw-alias-state-error-primary)'
            : view.tone === 'on' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)';
          return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 22,
            fontSize: 12, color }, 'data-unattended-row': view.tone },
          h('span', { 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: '50%',
            background: dot, flex: '0 0 auto' } }),
          h('span', { style: { overflowWrap: 'anywhere' } }, view.text));
        }
        function Toggle({ sessionId }) {
          const [, redraw] = React.useReducer(n => n + 1, 0);
          const [busy, setBusy] = React.useState(false);
          const [error, setError] = React.useState('');
          const mounted = React.useRef(false);
          React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
          const load = React.useCallback(async () => {
            if (!sessionId) return;
            try { await readState(sessionId); if (mounted.current) setError(''); }
            catch (cause) { if (mounted.current) setError(String(cause.message ?? cause)); }
          }, [sessionId]);
          React.useEffect(() => {
            mounted.current = true;
            listeners.add(redraw);
            load();
            // No log-writing status poll: refresh on focus or an explicit refresh click.
            const refresh = () => { if (document.visibilityState !== 'hidden') load(); };
            window.addEventListener('focus', refresh);
            return () => { mounted.current = false; listeners.delete(redraw); window.removeEventListener('focus', refresh); };
          }, [load]);
          const state = cache.get(sessionId);
          async function toggle() {
            if (busy || !state) return;
            setBusy(true); setError('');
            try { await setEnabled(sessionId, !state.enabled, state.revision); }
            catch (cause) {
              if (mounted.current) setError(String(cause.message ?? cause));
              // A second tab may have changed the revision: refresh, never toggle blindly.
              try { await readState(sessionId); } catch {}
            } finally { if (mounted.current) setBusy(false); }
          }
          const phaseName = typeof state?.phase === 'string' ? state.phase : '';
          const phase = !state?.enabled ? '' : phaseName === 'clarifying' ? t('wait') :
            phaseName.startsWith('waiting') ? t('waiting') : phaseName === 'complete' ? t('complete') : t('running');
          const buttonStyle = {
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', minHeight: 28,
            borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', font: 'inherit', fontSize: 12,
            color: state?.enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            background: 'var(--dsw-alias-bg-layer-1)', cursor: busy || !state ? 'wait' : 'pointer',
            whiteSpace: 'nowrap', flex: '0 0 auto',
          };
          const chipStyle = { border: 0, background: 'transparent', padding: '0 2px', cursor: 'pointer',
            fontSize: 12, lineHeight: '16px', flex: '0 0 auto', display: 'inline-flex', alignItems: 'center' };
          // Composer furniture is a single dense row: it must never wrap, stretch the
          // toolbar, or hold a long message inline. The reason for any failure lives in
          // a tooltip, so the row keeps its intrinsic size no matter how long the error is.
          const failure = error || (typeof state?.lastError === 'string' ? state.lastError : '');
          return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5,
            flex: '0 1 auto', minWidth: 0, maxWidth: '100%', flexWrap: 'nowrap', whiteSpace: 'nowrap' },
            'data-unattended-control': sessionId },
            h('button', { type: 'button', role: 'switch', 'aria-checked': !!state?.enabled,
              'aria-label': state?.enabled ? t('on') : t('off'), title: t('hint'),
              disabled: busy || !state || !sessionId, onClick: toggle, style: buttonStyle },
              h('span', { 'aria-hidden': true, style: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto',
                background: state?.enabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)' } }),
              busy ? t('busy') : state ? (state.enabled ? t('on') : t('off')) : t('loading')),
            // A short phase label only; it is bounded, so it cannot push the row.
            phase ? h('small', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11,
              maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto' } }, phase) : null,
            h('button', { type: 'button', onClick: load, title: t('refresh'), 'aria-label': t('refresh'),
              style: { ...chipStyle, color: 'var(--dsw-alias-label-secondary)' } }, '↻'),
            // Failures collapse to a one-character marker; the text is reachable on
            // hover/focus and announced through title, never laid out inline.
            failure ? h('button', { type: 'button', onClick: load, title: failure, 'aria-label': failure,
              style: { ...chipStyle, color: error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)' } },
              '⚠') : null);
        }
        disposers.push(ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'unattended-supervisor-toggle', order: 40,
          label: () => t('off'),
        }, Toggle)));
        // Command rows keyed by command name: this replaces the generic card for
        // `/unattended`, so a status read can never surface and a toggle stays one line.
        disposers.push(ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview', id: 'unattended-supervisor-commandview', key: 'unattended',
          label: () => t('off'),
        }, Row)));
        module.api = { readState, setEnabled, describeRow, statusRoute: () => statusRoute };
        ctx.effect(() => () => {
          alive = false;
          module.api = undefined;
          // reverse() mutates; copy first so a repeated disposal keeps the order.
          for (const dispose of [...disposers].reverse()) dispose?.();
          listeners.clear(); cache.clear();
        }, 'unattended-supervisor client disposal');
      },
    };
    return module;
  },
});
