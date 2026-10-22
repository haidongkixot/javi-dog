import { describe, expect, it } from 'vitest';
import { configuredProviders, personalWorkspaceName } from '../src/index.ts';

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
