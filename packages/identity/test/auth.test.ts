import { describe, expect, it } from 'vitest';
import { configuredProviders, personalWorkspaceName, redact } from '../src/index.ts';

describe('personalWorkspaceName', () => {
  it.each([
    ['Ada Lovelace', "Ada's workspace"],
    ['  grace   hopper ', "grace's workspace"],
    ['', 'My workspace'],
    ['   ', 'My workspace'],
  ])('%j → %j', (name, expected) => {
    expect(personalWorkspaceName(name)).toBe(expected);
  });

  it('caps very long first names', () => {
    expect(personalWorkspaceName('x'.repeat(200))).toBe(`${'x'.repeat(40)}'s workspace`);
  });
});

describe('configuredProviders', () => {
  it('needs both id and secret, and ignores blank values', () => {
    expect(configuredProviders({})).toEqual([]);
    expect(configuredProviders({ GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' })).toEqual([
      'github',
    ]);
    expect(configuredProviders({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: '  ' })).toEqual([]);
  });
});

describe('redact', () => {
  it('removes emails and token-like strings', () => {
    const out = redact(
      'user ada@example.com token gho_abc123 google ya29.a0Af jwt eyJa.eyJb.sig ingest jd_it_AAAA',
    );
    expect(out).toBe('user [email] token [secret] google [secret] jwt [secret] ingest [secret]');
  });
});

describe('redact (more token families)', () => {
  it.each([
    'ghr_abcdef123456',
    'github_pat_11ABCDEFG_abcdef',
    'sk-ant-api03-abcdefgh',
    'sk_live_abcdefghijk',
    're_AbCdEfGh_12345',
    'GOCSPX-abcdefg',
  ])('masks %s', (token) => {
    expect(redact(`value ${token} end`)).toBe('value [secret] end');
  });
});
