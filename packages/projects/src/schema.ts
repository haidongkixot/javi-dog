import { z } from 'zod';

/** Coding environments a project can report from (feasibility #3). */
export const platforms = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'cursor',
  'github',
  'custom-jgr',
] as const;
export const Platform = z.enum(platforms);
export type Platform = z.infer<typeof Platform>;

/**
 * JGR privacy classes. L0 is the default: operational metadata only (product rule 3).
 * L1 hashes identifiers on the client; L2 end-to-end encrypts payload fields with a user-held key.
 */
export const PrivacyClass = z.enum(['L0', 'L1', 'L2']);
export type PrivacyClass = z.infer<typeof PrivacyClass>;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Derive a URL-safe slug from a display name ("Javi's Dog Web App" → "javis-dog-web-app"). */
export const toSlug = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

/** What a user submits when registering a project. */
export const ProjectInput = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Use at least 2 characters.')
    .max(80, 'Use at most 80 characters.'),
  slug: z
    .string()
    .regex(SLUG, 'Use lowercase letters, numbers and single hyphens.')
    .max(48)
    .optional(),
  description: z.string().trim().max(280).optional(),
  platforms: z
    .array(Platform)
    .min(1, 'Pick at least one coding environment.')
    .max(platforms.length),
  privacyClass: PrivacyClass.default('L0'),
  repositoryUrl: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }).optional(),
});
export type ProjectInput = z.input<typeof ProjectInput>;

/** A registered project as stored by the registry (persistence arrives in S2). */
export const Project = ProjectInput.extend({
  id: z.uuid(),
  slug: z.string().regex(SLUG).max(48),
  workspaceId: z.uuid(),
  createdAt: z.iso.datetime(),
  /** Set only by a verified JGR signal — never by the client. */
  lastSignalAt: z.iso.datetime().nullable(),
});
export type Project = z.infer<typeof Project>;

/** Validate input and fill derived fields (slug, default privacy class). */
export const normalizeProjectInput = (raw: unknown) => {
  const parsed = ProjectInput.parse(raw);
  const slug = parsed.slug ?? toSlug(parsed.name);
  if (!SLUG.test(slug)) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['name'],
        message: 'Name must contain letters or numbers.',
        input: parsed.name,
      },
    ]);
  }
  return { ...parsed, slug };
};
