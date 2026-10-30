import { createHmac } from 'node:crypto';
import type { RecordInput } from '@javis-dog/jgr-sdk';

// Claude Code hook input → JGR event (spec §12, ADR-0010). Only operational metadata
// leaves this function: prompts, tool inputs/responses, assistant messages, transcript
// paths and cwd are never read into the output. The session folder (`cwd`) is read only for
// L1/L2 projects, and only into the separate `x.javi.thread.identity` event as keyed hashes
// and, for L2, ciphertext (ADR-0018 §4, §5; run.ts, session-folder.ts). Every event mapped
// here stays L0.

export const COLLECTOR_VERSION = '0.1.0';

/** Hook events the collector registers for. */
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Notification types that mean "the thread waits for a human" (code.claude.com/docs/en/hooks). */
export const ATTENTION_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'agent_needs_input',
]);

/** Keyed hash with the per-installation salt → opaque ref matching JGR's REF pattern. */
export const opaqueRef = (prefix: string, value: string, salt: string) =>
  `${prefix}_${createHmac('sha256', salt).update(value).digest('hex').slice(0, 32)}`;

const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

/** Tool names are allowlisted L0 metadata, but cap them to the attribute limit. */
const toolName = (value: unknown) => str(value)?.slice(0, 128) ?? null;

export interface MapContext {
  projectRef: string;
  salt: string;
}

/**
 * Returns the JGR event for one hook invocation, or `null` when the hook carries no
 * signal we keep (unknown event, missing session id, uninteresting notification).
 */
export const mapHook = (raw: unknown, ctx: MapContext): RecordInput | null => {
  if (!raw || typeof raw !== 'object') return null;
  const hook = raw as Record<string, unknown>;
  const sessionId = str(hook.session_id);
  const event = str(hook.hook_event_name);
  if (!sessionId || !event) return null;

  const base = {
    project_ref: ctx.projectRef,
    thread_ref: opaqueRef('cc', sessionId, ctx.salt),
    attributes: { platform: 'claude-code', collector_version: COLLECTOR_VERSION } as Record<
      string,
      string | number
    >,
  };
  const agentId = str(hook.agent_id);
  const agent = agentId ? { agent_ref: opaqueRef('ag', agentId, ctx.salt) } : {};
  const withTool = () => {
    const name = toolName(hook.tool_name);
    const ms = hook.duration_ms;
    return {
      ...base.attributes,
      ...(name && { tool_name: name }),
      ...(typeof ms === 'number' &&
        Number.isFinite(ms) &&
        ms >= 0 && { duration_ms: Math.round(ms) }),
    };
  };

  switch (event) {
    case 'SessionStart':
      return { ...base, type: 'session.started', status: 'working' };
    case 'SessionEnd':
      return { ...base, type: 'session.ended', status: 'completed' };
    case 'UserPromptSubmit':
      // The prompt text is never read (spec §12).
      return { ...base, ...agent, type: 'heartbeat', status: 'working' };
    case 'PreToolUse':
      return { ...base, ...agent, type: 'task.started', attributes: withTool() };
    case 'PostToolUse':
      return { ...base, ...agent, type: 'task.completed', attributes: withTool() };
    case 'PostToolUseFailure':
      return { ...base, ...agent, type: 'task.failed', attributes: withTool() };
    case 'Notification': {
      const kind = str(hook.notification_type);
      if (!kind || !ATTENTION_NOTIFICATIONS.has(kind)) return null;
      return { ...base, ...agent, type: 'attention.requested', status: 'waiting' };
    }
    case 'SubagentStart':
      return agentId ? { ...base, ...agent, type: 'agent.started', status: 'working' } : null;
    case 'SubagentStop':
      return agentId ? { ...base, ...agent, type: 'agent.stopped', status: 'completed' } : null;
    case 'Stop':
      return { ...base, type: 'heartbeat', status: 'idle' };
    default:
      return null;
  }
};
