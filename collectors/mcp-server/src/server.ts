import {
  SELF_REPORT,
  validateSelfReport,
  type SelfReportToolName,
} from '@javis-dog/collector-adapters';

// JD-C03: hand-written stdio MCP server for agent self-report (ADR-0017 decision 1). No I/O of
// its own and no `process` globals: the core reads lines it is given and writes JSON-RPC lines
// and fixed log strings through the caller's functions. Nothing a client sends is ever echoed,
// except a request `id` (JSON-RPC requires it) and a protocol version from our own known list.

/** Protocol versions echoed in `initialize`; any other request gets the first (ADR-0017 §1). */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const MCP_DEFAULT_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];

/** The closed set of stderr messages. Nothing else is ever logged (ADR-0017 §1, review L3). */
export const MCP_LOG_MESSAGES = Object.freeze({
  started: 'javi mcp: started',
  stopped: 'javi mcp: stopped',
  malformed: 'javi mcp: malformed message ignored',
  invalidRequest: 'javi mcp: invalid request',
  tooLarge: 'javi mcp: message too large',
  hooksCheckFailed: 'javi mcp: hooks check failed',
} as const);
export type McpLogMessage = (typeof MCP_LOG_MESSAGES)[keyof typeof MCP_LOG_MESSAGES];

const list = (values: readonly string[]) => values.join(', ');

/** `initialize` `instructions` (ADR-0017 §2; ≤ 1 000 characters). */
export const MCP_INSTRUCTIONS =
  "javi shows your state on the user's Javi's Dog dashboard, labelled as reported by you. " +
  'Call report_status only when your state really changes: blocked, waiting for the user, done, ' +
  'failed, or resuming work. Give a reason only with waiting, blocked or failed. ' +
  'Call report_task only when a meaningful unit of work starts, completes or fails, never per ' +
  'tool call. Only the listed values exist; there is no free text. ' +
  'Each call may ask the user for permission, so keep calls rare.';

/** MCP tool annotations, identical for both tools (ADR-0017 §2). */
export const MCP_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const);

const DESCRIPTIONS: Readonly<Record<SelfReportToolName, string>> = {
  report_status:
    'Report a real change of your state: blocked, waiting for the user, done, failed, or resuming ' +
    `work. status: ${list(SELF_REPORT.statuses)}. reason (only with ` +
    `${list(SELF_REPORT.reasonStatuses)}): ${list(SELF_REPORT.reasons)}. No free text.`,
  report_task:
    'Report a phase change of a meaningful unit of work, never per tool call. ' +
    `phase: ${list(SELF_REPORT.phases)}. kind: ${list(SELF_REPORT.kinds)}. No free text.`,
};

/** `tools/list` entries: names and schemas from JD-C02 `SELF_REPORT`. */
export const MCP_TOOLS = Object.freeze(
  SELF_REPORT.tools.map((name) =>
    Object.freeze({
      name,
      description: DESCRIPTIONS[name],
      inputSchema: SELF_REPORT.schemas[name],
      annotations: MCP_TOOL_ANNOTATIONS,
    }),
  ),
);

/** Constant `tools/call` result texts. None contains any part of a request. */
export const MCP_RESULT_TEXTS = Object.freeze({
  noted: Object.freeze({
    report_status: "noted: javi's hooks record this status for the dashboard",
    report_task: "noted: javi's hooks record this task phase for the dashboard",
  }),
  invalid: Object.freeze({
    report_status:
      `not recorded: invalid arguments. report_status takes status (${list(SELF_REPORT.statuses)}) ` +
      `and an optional reason (${list(SELF_REPORT.reasons)}), allowed only with ` +
      `${list(SELF_REPORT.reasonStatuses)}. No other keys.`,
    report_task:
      `not recorded: invalid arguments. report_task takes phase (${list(SELF_REPORT.phases)}) ` +
      `and kind (${list(SELF_REPORT.kinds)}). No other keys.`,
  }),
  hooksMissing: 'not recorded: javi hooks are not installed for this project',
} as const);

/** JSON-RPC error codes and their fixed messages. */
export const JSON_RPC_ERRORS = Object.freeze({
  parse: Object.freeze({ code: -32700, message: 'Parse error' }),
  invalidRequest: Object.freeze({ code: -32600, message: 'Invalid Request' }),
  notInitialized: Object.freeze({ code: -32600, message: 'Server not initialized' }),
  methodNotFound: Object.freeze({ code: -32601, message: 'Method not found' }),
  invalidParams: Object.freeze({ code: -32602, message: 'Invalid params' }),
} as const);
type RpcError = (typeof JSON_RPC_ERRORS)[keyof typeof JSON_RPC_ERRORS];

export interface McpServerOptions {
  /** `serverInfo.version` (the installed javi version). */
  version: string;
  /** Are javi's hooks installed for this platform and project? A throw counts as "no". */
  hooksInstalled: () => boolean | Promise<boolean>;
  /** Writes one serialized JSON-RPC message, already terminated by `\n`. */
  write(line: string): void;
  /** Writes one fixed log string (from `MCP_LOG_MESSAGES`) to stderr. */
  log(message: McpLogMessage): void;
}

export interface McpServer {
  /** Handles one stdin line (without its `\n`; a trailing `\r` is ignored). */
  handleLine(line: string): Promise<void>;
  /** Answers a message the transport had to drop unread (too large) with `-32700`. */
  rejectLine(): void;
}

type Id = string | number;
type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (value: Obj, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const own = (value: Obj, key: string): unknown => (has(value, key) ? value[key] : undefined);
const isId = (value: unknown): value is Id =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const isToolName = (value: unknown): value is SelfReportToolName =>
  typeof value === 'string' && (SELF_REPORT.tools as readonly string[]).includes(value);

/**
 * The MCP server core (ADR-0017 §1):
 *
 * - `initialize` echoes a known protocol version (else `2025-11-25`) and returns
 *   `capabilities.tools.listChanged: false`, `serverInfo` and `instructions`; `ping` answers `{}`.
 * - `tools/list` and `tools/call` before `initialize` → `-32600`. Unknown methods, including
 *   `server/discover`, → `-32601` at any time, so modern clients fall back to `initialize`.
 * - Notifications (no `id`) and responses are never answered. `id` is echoed with its type.
 * - Malformed JSON → `-32700` with `id: null`; a batch (array) or a non-object → `-32600`.
 * - `tools/call`: unknown tool or bad params → `-32602`; invalid arguments → `isError` with a
 *   constant text; hooks not installed → `isError` "not recorded: …"; else a constant "noted".
 */
export const createMcpServer = (opts: McpServerOptions): McpServer => {
  let initialized = false;
  const send = (message: object) => opts.write(`${JSON.stringify(message)}\n`);
  const reply = (id: Id, result: object) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: Id | null, error: RpcError) =>
    send({ jsonrpc: '2.0', id, error: { code: error.code, message: error.message } });

  const hooksInstalled = async () => {
    try {
      return (await opts.hooksInstalled()) === true;
    } catch {
      opts.log(MCP_LOG_MESSAGES.hooksCheckFailed);
      return false;
    }
  };
  const text = (value: string, isError: boolean) => ({
    content: [{ type: 'text', text: value }],
    isError,
  });

  const initialize = (params: unknown) => {
    const requested = isObj(params) ? own(params, 'protocolVersion') : undefined;
    const protocolVersion =
      MCP_PROTOCOL_VERSIONS.find((known) => known === requested) ?? MCP_DEFAULT_PROTOCOL_VERSION;
    initialized = true;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SELF_REPORT.serverName, version: opts.version },
      instructions: MCP_INSTRUCTIONS,
    };
  };

  const callTool = async (id: Id, params: unknown) => {
    if (!isObj(params)) return fail(id, JSON_RPC_ERRORS.invalidParams);
    const name = own(params, 'name');
    if (!isToolName(name)) return fail(id, JSON_RPC_ERRORS.invalidParams);
    if (!validateSelfReport(name, own(params, 'arguments')).ok) {
      return reply(id, text(MCP_RESULT_TEXTS.invalid[name], true));
    }
    if (!(await hooksInstalled())) return reply(id, text(MCP_RESULT_TEXTS.hooksMissing, true));
    return reply(id, text(MCP_RESULT_TEXTS.noted[name], false));
  };

  const handleMessage = async (message: unknown) => {
    if (!isObj(message)) {
      opts.log(MCP_LOG_MESSAGES.invalidRequest);
      return fail(null, JSON_RPC_ERRORS.invalidRequest);
    }
    const hasId = has(message, 'id');
    const id = own(message, 'id');
    const method = own(message, 'method');
    if (method === undefined && hasId && (has(message, 'result') || has(message, 'error'))) {
      return; // A response to a request we never send: ignored.
    }
    if (own(message, 'jsonrpc') !== '2.0' || typeof method !== 'string') {
      opts.log(MCP_LOG_MESSAGES.invalidRequest);
      // Without an id it cannot be answered (it may be a malformed notification).
      return hasId ? fail(isId(id) ? id : null, JSON_RPC_ERRORS.invalidRequest) : undefined;
    }
    if (!hasId) return; // Notification: never answered.
    if (!isId(id)) {
      opts.log(MCP_LOG_MESSAGES.invalidRequest);
      return fail(null, JSON_RPC_ERRORS.invalidRequest);
    }
    const params = own(message, 'params');
    switch (method) {
      case 'initialize':
        return reply(id, initialize(params));
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return initialized
          ? reply(id, { tools: MCP_TOOLS })
          : fail(id, JSON_RPC_ERRORS.notInitialized);
      case 'tools/call':
        return initialized ? callTool(id, params) : fail(id, JSON_RPC_ERRORS.notInitialized);
      default:
        return fail(id, JSON_RPC_ERRORS.methodNotFound);
    }
  };

  return {
    async handleLine(line) {
      const body = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (body.trim() === '') return;
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        opts.log(MCP_LOG_MESSAGES.malformed);
        return fail(null, JSON_RPC_ERRORS.parse);
      }
      if (Array.isArray(message)) {
        opts.log(MCP_LOG_MESSAGES.invalidRequest);
        return fail(null, JSON_RPC_ERRORS.invalidRequest);
      }
      await handleMessage(message);
    },
    rejectLine() {
      opts.log(MCP_LOG_MESSAGES.tooLarge);
      fail(null, JSON_RPC_ERRORS.parse);
    },
  };
};

/** Lines longer than this (UTF-16 code units) are dropped unread and answered `-32700`. */
export const MCP_MAX_LINE_LENGTH = 1024 * 1024;

export interface StdioServerOptions {
  version: string;
  hooksInstalled: () => boolean | Promise<boolean>;
  /** Defaults to `MCP_MAX_LINE_LENGTH`. */
  maxLineLength?: number;
}

/**
 * Pumps newline-delimited JSON-RPC from `stdin` through `createMcpServer`, one message at a
 * time and in order. stdout gets only JSON-RPC lines, stderr only `MCP_LOG_MESSAGES`. Resolves
 * once stdin ends (or fails) and every pending message is answered. `javi mcp` (JD-C01) passes
 * `process.stdin`, `process.stdout` and `process.stderr`.
 */
export const serveStdio = (
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  opts: StdioServerOptions,
): Promise<void> => {
  const max = opts.maxLineLength ?? MCP_MAX_LINE_LENGTH;
  const ignore = () => {};
  // A client that went away must not crash the server with EPIPE.
  stdout.on('error', ignore);
  stderr.on('error', ignore);
  const log = (message: McpLogMessage) => {
    stderr.write(`${message}\n`);
  };
  const server = createMcpServer({
    version: opts.version,
    hooksInstalled: opts.hooksInstalled,
    write: (line) => {
      stdout.write(line);
    },
    log,
  });
  log(MCP_LOG_MESSAGES.started);

  return new Promise<void>((resolve) => {
    let buffer = '';
    let dropping = false;
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (task: () => void | Promise<void>) => {
      chain = chain.then(task).catch(ignore);
    };
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (dropping) dropping = false;
        else enqueue(() => server.handleLine(line));
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > max) {
        buffer = '';
        if (!dropping) {
          dropping = true;
          enqueue(() => server.rejectLine());
        }
      }
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const rest = buffer;
      buffer = '';
      if (rest && !dropping) enqueue(() => server.handleLine(rest));
      enqueue(() => log(MCP_LOG_MESSAGES.stopped));
      void chain.then(resolve);
    };
    stdin.on('end', finish);
    stdin.on('close', finish);
    stdin.on('error', finish);
  });
};
