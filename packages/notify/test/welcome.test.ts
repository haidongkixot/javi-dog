import { describe, expect, it, vi } from 'vitest';
import { NotifyError, sendWelcomeEmail, welcomeEmail } from '../src/index.ts';

const config = {
  apiKey: 're_test',
  from: "Javi's Dog <hello@example.com>",
  appUrl: 'https://app.example',
};

describe('welcomeEmail', () => {
  it('greets by first name, links to projects and makes no unverified claims', () => {
    const { subject, text, html } = welcomeEmail({ name: 'Ada Lovelace', appUrl: config.appUrl });
    expect(subject).toBe("Welcome to Javi's Dog — your workspace is ready");
    expect(text).toContain('Hi Ada,');
    expect(text).toContain('https://app.example/projects');
    expect(`${text} ${html}`).not.toMatch(/\b(live|secure|encrypted)\b/i);
  });

  it('escapes the name in HTML and falls back when it is empty', () => {
    expect(welcomeEmail({ name: '<script>x', appUrl: config.appUrl }).html).toContain(
      '&#60;script&#62;x',
    );
    expect(welcomeEmail({ name: '  ', appUrl: config.appUrl }).text).toContain('Hi there,');
  });
});

describe('sendWelcomeEmail', () => {
  it('posts one email to Resend', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'email_123' }));
    const res = await sendWelcomeEmail(
      { ...config, fetch: fetchMock },
      { email: 'ada@example.com', name: 'Ada' },
    );
    expect(res).toEqual({ id: 'email_123' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: config.from,
      to: ['ada@example.com'],
    });
  });

  it('throws a NotifyError that carries the status but not the address', async () => {
    const fetchMock = vi.fn(async () => new Response('domain not verified', { status: 403 }));
    const error = await sendWelcomeEmail(
      { ...config, fetch: fetchMock },
      { email: 'ada@example.com', name: 'Ada' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotifyError);
    expect((error as NotifyError).status).toBe(403);
    expect(String((error as Error).message)).not.toContain('ada@example.com');
  });
});
