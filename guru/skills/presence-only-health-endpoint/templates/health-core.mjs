// Presence-only health check core (guru skill `presence-only-health-endpoint`).
// Framework-agnostic: wire `checkHealth` into any HTTP handler and send the body as JSON
// with `Cache-Control: no-store`. Run `node health-core.mjs --self-test` to check the
// guarantees below before you adapt it.
//
// Guarantees: env vars are reported as booleans only; blank values count as missing;
// the DB is never pinged without a URL; driver errors and hung pings become a state word
// (never a message, host or stack); the deployed commit and environment name are reported
// so you can tell which build answered.

/** True when the variable is set to a non-blank string. Never returns or logs the value. */
export const present = (value) => typeof value === 'string' && value.trim() !== '';

const withTimeout = (work, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

/**
 * @param {object} deps
 * @param {readonly string[]} deps.names   env var NAMES to report (an allowlist, not process.env keys)
 * @param {Record<string, string | undefined>} deps.env
 * @param {(url: string) => Promise<{ latencyMs: number, migrationsApplied: number }>} [deps.ping]
 * @param {string} [deps.dbUrlName]        name of the DB URL variable, e.g. 'DATABASE_URL'
 * @param {{ env?: string, commit?: string }} [deps.deployment]  from your platform's build vars
 * @param {() => Date} [deps.now]
 * @param {number} [deps.timeoutMs]
 */
export const checkHealth = async ({
  names,
  env,
  ping,
  dbUrlName = 'DATABASE_URL',
  deployment = {},
  now = () => new Date(),
  timeoutMs = 3000,
}) => {
  let db = { status: 'not_configured', latencyMs: null, migrationsApplied: null };
  const url = env[dbUrlName];
  if (ping && present(url)) {
    try {
      db = { status: 'ok', ...(await withTimeout(ping(url), timeoutMs)) };
    } catch {
      // Driver errors can echo hosts or credentials: report the state only.
      db = { status: 'error', latencyMs: null, migrationsApplied: null };
    }
  }
  const body = {
    status: db.status === 'ok' ? 'ok' : 'degraded',
    checkedAt: now().toISOString(),
    deployment: { env: deployment.env ?? 'local', commit: deployment.commit?.slice(0, 7) ?? null },
    env: Object.fromEntries(names.map((name) => [name, present(env[name])])),
    db,
  };
  return { httpStatus: db.status === 'ok' ? 200 : 503, body };
};

const selfTest = async () => {
  const assert = (cond, label) => {
    if (!cond) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const SECRET = 'postgresql://user:hunter2@secret-host.example/db';
  const names = ['DATABASE_URL', 'AUTH_SECRET', 'EMAIL_FROM'];
  const ok = async () => ({ latencyMs: 5, migrationsApplied: 2 });

  const full = await checkHealth({
    names,
    env: { DATABASE_URL: SECRET, AUTH_SECRET: 'value-a', EMAIL_FROM: '  ' },
    ping: ok,
    deployment: { env: 'production', commit: 'abcdef1234567' },
  });
  const json = JSON.stringify(full.body);
  assert(!json.includes('hunter2') && !json.includes('value-a'), 'no value is echoed');
  assert(full.body.env.EMAIL_FROM === false, 'blank value counts as missing');
  assert(
    full.httpStatus === 200 && full.body.deployment.commit === 'abcdef1',
    '200 + short commit',
  );

  let pinged = false;
  const none = await checkHealth({ names, env: {}, ping: async () => (pinged = true) });
  assert(none.httpStatus === 503 && !pinged, 'no URL -> 503 not_configured, no ping');

  const failing = await checkHealth({
    names,
    env: { DATABASE_URL: SECRET },
    ping: async () => {
      throw new Error(`connect failed for ${SECRET}`);
    },
  });
  assert(
    failing.body.db.status === 'error' && !JSON.stringify(failing.body).includes('hunter2'),
    'driver error -> state word only',
  );

  const hung = await checkHealth({
    names,
    env: { DATABASE_URL: SECRET },
    ping: () => new Promise(() => {}),
    timeoutMs: 50,
  });
  assert(hung.body.db.status === 'error', 'hung ping -> error after timeout');
};

if (process.argv.includes('--self-test')) {
  selfTest().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
