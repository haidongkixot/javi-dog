import { describe, expect, it } from 'vitest';
import { normalizeProjectInput, Project, ProjectInput, toSlug } from '../src/index.ts';

describe('toSlug', () => {
  it.each([
    ["Javi's Dog Web App", 'javis-dog-web-app'],
    ['  Telemetry   SDK  ', 'telemetry-sdk'],
    ['Đồ án Vibe Coding', 'do-an-vibe-coding'],
    ['API Connector Lab!!', 'api-connector-lab'],
  ])('%s → %s', (name, slug) => {
    expect(toSlug(name)).toBe(slug);
  });

  it('caps length at 48 without a trailing hyphen', () => {
    const slug = toSlug('a'.repeat(47) + ' bcd');
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('ProjectInput', () => {
  it('defaults the privacy class to L0 (privacy by minimization)', () => {
    const p = ProjectInput.parse({ name: 'Storefront', platforms: ['cursor'] });
    expect(p.privacyClass).toBe('L0');
  });

  it('requires at least one platform', () => {
    expect(ProjectInput.safeParse({ name: 'Storefront', platforms: [] }).success).toBe(false);
  });

  it('accepts only https GitHub repository URLs', () => {
    const base = { name: 'Storefront', platforms: ['github'] };
    expect(
      ProjectInput.safeParse({ ...base, repositoryUrl: 'https://github.com/a/b' }).success,
    ).toBe(true);
    expect(
      ProjectInput.safeParse({ ...base, repositoryUrl: 'http://github.com/a/b' }).success,
    ).toBe(false);
    expect(
      ProjectInput.safeParse({ ...base, repositoryUrl: 'https://evil.example/a/b' }).success,
    ).toBe(false);
  });

  it('rejects unknown privacy classes and platforms', () => {
    expect(ProjectInput.safeParse({ name: 'X1', platforms: ['vscode'] }).success).toBe(false);
    expect(
      ProjectInput.safeParse({ name: 'X1', platforms: ['github'], privacyClass: 'L9' }).success,
    ).toBe(false);
  });
});

describe('normalizeProjectInput', () => {
  it('derives the slug from the name', () => {
    expect(
      normalizeProjectInput({ name: 'Prompt QA Suite', platforms: ['claude-code'] }).slug,
    ).toBe('prompt-qa-suite');
  });

  it('rejects names that produce an empty slug', () => {
    expect(() => normalizeProjectInput({ name: '!!!', platforms: ['claude-code'] })).toThrow();
  });
});

describe('Project', () => {
  it('keeps lastSignalAt nullable — a new project has no signal', () => {
    const p = Project.parse({
      id: '9d7f8a8e-1c55-4a5b-9a3e-0c6a9c3d2b11',
      workspaceId: '2c1f3e4d-5b6a-4c7d-8e9f-0a1b2c3d4e5f',
      name: 'Telemetry SDK',
      slug: 'telemetry-sdk',
      platforms: ['custom-jgr'],
      createdAt: '2026-10-20T19:00:00Z',
      lastSignalAt: null,
    });
    expect(p.lastSignalAt).toBeNull();
  });
});
