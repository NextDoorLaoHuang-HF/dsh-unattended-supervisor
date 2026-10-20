import { z } from 'zod';
import Schema from '@deepseek-ai/schemastery';
import { SupervisorController, FLASH_ROUTES } from './controller.js';

export const name = 'unattended-supervisor';
// timer supplies ctx.interval; every other entry is a service this plugin reads.
export const inject = ['agents', 'commands', 'tools', 'systemPrompt', 'storageDomain', 'timer'];
// Config is a NATIVE Schemastery schema, not zod: DSH only renders a Settings form
// for native schemas (a zod Config marks the row `unsupported`), and the Loader
// validates through the same `Config['~standard'].validate()` path either way.
// Schemastery fills every `default()` for an omitted config, which a zod
// `.default({})` wrapper did not.
export const Config = Schema.object({
  idleDelayMs: Schema.number().min(1000).max(3600000).default(15000)
    .description('Quiet time before an auxiliary progress checkpoint may follow up, in milliseconds.'),
  sweepMs: Schema.number().min(1000).max(60000).default(5000)
    .description('How often enabled sessions are swept for work to continue, in milliseconds.'),
  maxNudges: Schema.number().min(1).max(100).default(12)
    .description('Hard cap on plugin-initiated follow-ups per session.'),
  maxStalls: Schema.number().min(1).max(20).default(3)
    .description('Consecutive no-progress follow-ups before the plugin backs off.'),
  childGraceMs: Schema.number().min(1000).max(3600000).default(120000)
    .description('How long a delegated child may stay unknown to the runtime before its bookkeeping is dropped, in milliseconds.'),
  mailGraceMs: Schema.number().min(0).max(300000).default(15000)
    .description('Delay before mailing a pending approval or question, so a present user wins, in milliseconds.'),
  mailTimeoutMs: Schema.number().min(1000).max(120000).default(30000)
    .description('Hard limit for one mail CLI invocation, in milliseconds.'),
  mailCli: Schema.string().default('/opt/homebrew/bin/agently-cli')
    .description('Absolute path to the mail CLI used for decision notices.'),
  mailRecipient: Schema.string().default('')
    .description('Recipient of decision notices (a plain email address). Empty by default: decision mail stays disabled and every notice fails with an explicit configuration error until you set your own address.'),
});

// Durable domain identity. A domain name must match UNIT_NAME_RE
// (/^[a-z][a-z0-9_]*$/ in @deepseek-ai/dsh-storage), so the hyphenated package
// name cannot be reused here.
export const DOMAIN_NAME = 'unattended_supervisor';

// Exact Fetch route for the read-only status read. Plain segments only: Connection
// validates every path segment against /^[A-Za-z0-9_$.-]+$/ before registering.
export const STATUS_ROUTE = '/api/unattended.status';
const textArray = { type: 'array', items: { type: 'string', maxLength: 2000 }, maxItems: 20 };
const output = { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const errorText = error => error instanceof Error ? error.message : String(error);
const statusTool = 'unattended_status';

export async function apply(ctx, rawConfig = {}) {
  // The Loader has already resolved the row's config against Config; calling the
  // schema again is what guarantees defaults when apply() is mounted directly (as
  // the harness smoke test and any embedder may do). Schemastery validates by call.
  const config = Config(rawConfig);
  const controller = new SupervisorController(ctx, config);
  const domain = await ctx.storageDomain.open({
    name: DOMAIN_NAME, version: 1, layout: 'per-record',
    tables: {
      tasks: { valueSchema: z.object({ sessionId: z.string(), enabled: z.boolean(), revision: z.number().int().nonnegative() }).passthrough() },
      outbox: { valueSchema: z.object({ sessionId: z.string(), decisionId: z.string(), revision: z.number().int(), status: z.string() }).passthrough() },
    },
  });
  await controller.initialize(domain);
  const owned = new Map();
  const cleanup = [];
  let sweeping = false;
  const own = dispose => { cleanup.push(dispose); return dispose; };
  const logFailure = error => ctx.logger.warn(`unattended: ${errorText(error)}`);
  const rootAgent = exec => {
    if (!exec.agent || !controller.root(exec.agent)) throw new Error('This tool requires the owning top-level session.');
    return exec.agent;
  };
  const register = definition => own(ctx.tools.register({ ...definition, output }));

  try {
    // The service is local-only; the existing human Commands remote is the UI transport.
    // No model tool grants enable/disable authority.
    own(ctx.provide('unattendedSupervisor', controller));
    own(ctx.commands.register({
      definitionId: 'dsh-unattended-supervisor/unattended', name: 'unattended',
      description: 'Switch unattended assistance on/off without stopping the task; or inspect status',
      input: { hint: '[on|off|status] [expected-revision]' },
      async handler({ agent, rawInput, signal }) {
        try {
          if (signal.aborted) throw new Error('Command cancelled.');
          const [action = 'status', rev, ...extra] = rawInput.trim().split(/\s+/).filter(Boolean);
          if (extra.length || !['on', 'off', 'status'].includes(action) || (rev !== undefined && !/^\d+$/.test(rev))) throw new Error('Usage: /unattended [on|off|status] [expected-revision]');
          const state = action === 'status' ? controller.view(agent.id) : await controller.setEnabled(agent, action === 'on', rev === undefined ? undefined : Number(rev));
          return { kind: 'success', text: JSON.stringify(state) };
        } catch (error) { return { kind: 'error', text: errorText(error) }; }
      },
    }));

    // Read-only UI transport. The composer switch used to read state by executing
    // `/unattended status` through the Commands remote, and the executor logs every
    // resolved command as a `command/run`/`command/done` pair that the transcript
    // renders as a row — so every focus refresh left a JSON row at the tail of the
    // conversation. This exact route answers the same view without touching the
    // command lifecycle. It is mounted only when a Web connection is composed, and
    // Connection admits only the owner principal to an exact Fetch route.
    ctx.inject(['connection'], connectionCtx => {
      connectionCtx.effect(() => connectionCtx.connection.fetch.register({
        path: STATUS_ROUTE, methods: ['GET'], requestBody: 'buffered',
        fetch(request) {
          const sessionId = new URL(request.url).searchParams.get('sessionId') ?? '';
          const agent = sessionId ? ctx.agents.get(sessionId) : undefined;
          if (!agent || !controller.root(agent)) {
            return Promise.resolve(Response.json({ ok: false, error: 'Session unavailable' }, { status: 404, headers: { 'cache-control': 'no-store' } }));
          }
          return Promise.resolve(Response.json({ ok: true, state: controller.view(agent.id) },
            { headers: { 'cache-control': 'no-store' } }));
        },
      }), `unattended-supervisor: ${STATUS_ROUTE}`);
    });

    register({ name: statusTool, description: 'Read current-session unattended mode and task ledger. This cannot enable or disable the mode.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute(_args, exec) { return controller.view(rootAgent(exec).id); },
    });
    register({ name: 'unattended_checkpoint', description: 'When unattended mode is ON, record the clarified task contract, actual progress and verification evidence. This never starts, stops, or authorizes a task. complete requires acceptance criteria and evidence; it switches off only this plugin.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        objective: { type: 'string', maxLength: 4000 }, acceptance: textArray, decisions: textArray,
        phase: { type: 'string', enum: ['clarifying', 'running', 'waiting_dependency', 'waiting_human', 'verifying', 'complete'] },
        nextAction: { type: 'string', maxLength: 4000 }, evidence: textArray, summary: { type: 'string', maxLength: 4000 },
      } },
      async execute(args, exec) {
        if (exec.signal.aborted) throw new Error('Checkpoint cancelled.');
        return controller.checkpoint(rootAgent(exec), args);
      },
    });
    register({ name: 'unattended_request_user', description: 'Only when unattended mode is ON and the user really must decide: send one QQ email decision notice to the configured owner. Supply a stable decisionId; never send secrets or full tool inputs. This does not approve anything or listen to email replies. Ask the user in the DSH conversation as well.',
      parameters: { type: 'object', additionalProperties: false, required: ['decisionId', 'question'], properties: {
        decisionId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' }, question: { type: 'string', minLength: 1, maxLength: 4000 },
        options: textArray, recommendation: { type: 'string', maxLength: 4000 }, attempted: textArray, impact: { type: 'string', maxLength: 4000 },
      } },
      async execute(args, exec) { return controller.requestUser(rootAgent(exec), args, exec.signal); },
    });

    const attach = agent => {
      if (owned.has(agent) || !controller.root(agent)) return;
      // A scoped context is logged by the runtime-context machinery at each admitted step.
      const dispose = agent.ctx.systemPrompt.context({ name: 'unattended-supervisor', order: 975,
        text: () => controller.instructions(agent.id) });
      // subagent/start|end carry only {runId, provider, id, local}: the run info has
      // no parent field. Dispatch is scope-filtered by the delegating parent, so an
      // agent-scoped listener observes exactly this agent's delegations and supplies
      // the parent identity itself.
      const start = agent.ctx.on('subagent/start', info => { controller.childStarted(agent.id, info); });
      const end = agent.ctx.on('subagent/end', info => { controller.childEnded(agent.id, info); });
      owned.set(agent, () => { end(); start(); dispose(); });
      controller.lastIdle.set(agent.id, Date.now());
    };
    own(ctx.on('agent/created', ({ agent }) => { attach(agent); }));
    own(ctx.on('agent/disposed', ({ agent }) => {
      owned.get(agent)?.(); owned.delete(agent);
      if (controller.engine.listEnabled().includes(agent.id)) controller.stopTracking(agent.id, 'Session unloaded');
    }));
    own(ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') controller.lastIdle.set(agent.id, Date.now()); }));
    own(ctx.on('session/event', (session, event) => { controller.onEvent(session, event); }));
    own(ctx.on('workspace/session-stop', ({ sessionId }) => {
      if (controller.engine.listEnabled().includes(sessionId)) controller.stopTracking(sessionId, 'User stopped session activity');
    }));

    // Passive observers. Approval waiting moved to the authoritative session/event
    // channel (controller.onEvent on approval/asked|decided): that broadcast is
    // post-commit and cannot be truncated by any answerer, unlike the
    // `approval/request` waterfall this used to race with.
    // user-questions has no audit event, so it keeps the waterfall — but prepended
    // (always ahead of the GUI answerer) and fully try/catch-guarded: an observer
    // that throws without calling next() would deadlock the user's answer chain
    // (dsh-user-approval normalizes a thrown waterfall to 'unavailable').
    const guard = (observer) => (request, next) => {
      let detail;
      try { detail = observer(request); }
      catch (error) { ctx.logger.warn(`unattended: question observer failed: ${errorText(error)}`); return next(); }
      if (!detail) return next();
      try { controller.waitStarted(request.agent.id, detail); }
      catch (error) { ctx.logger.warn(`unattended: wait registration failed: ${errorText(error)}`); }
      return Promise.resolve().then(next).finally(() => {
        try { controller.waitSettled(detail.decisionId); }
        catch (error) { ctx.logger.warn(`unattended: wait settle failed: ${errorText(error)}`); }
      });
    };
    own(ctx.on('user-questions/request', guard(request => {
      const agent = request.agent;
      if (!agent || !controller.root(agent)) return null;
      if (!controller.isEnabled(agent.id)) return null;
      const questions = request.questions ?? [];
      const key = String(request.wait?.callId ?? questions.map(q => q.id).join('-') ?? 'pending').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'pending';
      return { kind: 'question', decisionId: `question-${key}`,
        question: questions.map(q => q.question).join('\n').slice(0, 4000),
        options: questions.flatMap(q => (q.options ?? []).map(o => o.label)).slice(0, 20),
        recommendation: questions.some(q => q.intent?.kind === 'plan-review') ? '请回到 DSH 审阅并决定是否批准计划。' : '请回到 DSH 对应会话回答；没有回复不会视为同意。',
      };
    }), { prepend: true }));

    for (const agent of ctx.agents.list()) attach(agent);
    own(ctx.interval(() => {
      if (sweeping || !controller.active) return;
      sweeping = true;
      controller.track(controller.sweep()).catch(logFailure).finally(() => { sweeping = false; });
    }, config.sweepMs));
    ctx.effect(() => async () => {
      controller.active = false;
      for (const dispose of [...cleanup].reverse()) dispose?.();
      for (const dispose of owned.values()) dispose?.();
      owned.clear();
      await controller.close();
    }, 'unattended-supervisor cleanup without cancelling tasks');
  } catch (error) {
    controller.active = false;
    for (const dispose of [...cleanup].reverse()) dispose?.();
    for (const dispose of owned.values()) dispose?.();
    await controller.close();
    throw error;
  }
}

export { FLASH_ROUTES };
