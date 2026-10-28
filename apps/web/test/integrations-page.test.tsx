// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

// S5a review I2: /api/v1/events accepts ingest tokens since S3a. The page must say so without
// claiming that the viewer's own agents are live (product rules 2 and 4).

const { default: IntegrationsPage } = await import('@/app/integrations/page');

afterEach(cleanup);

const envelope = () => screen.getByRole('region', { name: 'JGR event envelope' });

describe('JGR & Integrations — ingestion endpoint copy', () => {
  it('no longer says the endpoint is not live or waits for Sprint 3', () => {
    render(<IntegrationsPage />);
    const text = envelope().textContent ?? '';
    expect(text).not.toMatch(/not live/i);
    expect(text).not.toMatch(/once ingestion ships|Sprint 3/i);
    expect(text).not.toMatch(/not a production API/i);
  });

  it('says the endpoint accepts ingest tokens and where to get one', () => {
    render(<IntegrationsPage />);
    const block = envelope();
    expect(within(block).getByText('/api/v1/events')).toBeTruthy();
    const text = block.textContent ?? '';
    expect(text).toContain('Accepts project ingest tokens');
    expect(text).toContain('project page');
    expect(text).toContain('javi init');
  });

  it('never calls the viewer’s connection live', () => {
    render(<IntegrationsPage />);
    expect(envelope().textContent).not.toMatch(/\blive\b|connected|verified/i);
  });
});
