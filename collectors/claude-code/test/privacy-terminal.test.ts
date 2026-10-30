import { describe, expect, it } from 'vitest';
import { AGENT_ENV_MARKERS, promptHiddenFromTerminal, terminalRefusal } from '../src/privacy.ts';

// Security review M3 (S5f): the hidden prompt refuses inside a coding agent and without an
// interactive terminal, before it opens /dev/tty or touches the terminal mode.

const allTty = () => true;

describe('terminalRefusal', () => {
  it('names the documented agent markers', () => {
    expect([...AGENT_ENV_MARKERS]).toEqual([
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CODEX_THREAD_ID',
      'CODEX_SESSION_ID',
      'CODEX_SANDBOX',
      'CODEX_SANDBOX_NETWORK_DISABLED',
      'GEMINI_CLI',
    ]);
  });

  it.each(AGENT_ENV_MARKERS.map((m) => [m]))('refuses when %s is set (any value)', (marker) => {
    for (const value of ['1', 'cli', '']) {
      expect(terminalRefusal({ PATH: '/bin', [marker]: value }, allTty)).toEqual({
        reason: 'agent',
        marker,
      });
    }
  });

  it('ignores look-alikes the user may set in a shell (CODEX_HOME, GEMINI_CLI_HOME, …)', () => {
    const env = {
      CODEX_HOME: '/h/.codex',
      GEMINI_CLI_HOME: '/h',
      CLAUDE_PROJECT_DIR: '/p',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    };
    expect(terminalRefusal(env, allTty)).toBeNull();
  });

  it('refuses unless stdin, stdout and stderr are all terminals', () => {
    for (const notTty of [0, 1, 2]) {
      expect(
        terminalRefusal({}, (fd) => fd !== notTty),
        `fd ${notTty}`,
      ).toEqual({
        reason: 'no-terminal',
      });
    }
    expect(terminalRefusal({}, allTty)).toBeNull();
  });

  it('the agent check comes first', () => {
    expect(terminalRefusal({ GEMINI_CLI: '1' }, () => false)).toEqual({
      reason: 'agent',
      marker: 'GEMINI_CLI',
    });
  });
});

describe('promptHiddenFromTerminal refusals', () => {
  it('inside an agent: refused without opening the terminal', async () => {
    let asked = 0;
    const result = await promptHiddenFromTerminal('never shown: ', {
      env: { CLAUDECODE: '1' },
      isTty: () => {
        asked++;
        return true;
      },
      openTerminal: () => {
        throw new Error('the terminal must not be opened');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'agent', marker: 'CLAUDECODE' });
    expect(asked).toBe(0);
  });

  it('without a terminal on stdio: refused without opening the terminal', async () => {
    const result = await promptHiddenFromTerminal('never shown: ', {
      env: {},
      isTty: (fd) => fd !== 0,
      openTerminal: () => {
        throw new Error('the terminal must not be opened');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'no-terminal' });
  });
});
