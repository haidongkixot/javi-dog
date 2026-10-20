// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoBanner, MetricCard, StatusPill } from '../src/components/index.ts';

afterEach(cleanup);

describe('StatusPill', () => {
  it('carries a text label, not color alone', () => {
    render(<StatusPill tone="danger">Blocked</StatusPill>);
    expect(screen.getByText('Blocked').className).toContain('text-danger');
  });
});

describe('DemoBanner', () => {
  it('announces the disclosure as a status region', () => {
    render(<DemoBanner title="Preview">No backend is connected yet.</DemoBanner>);
    expect(screen.getByRole('status').textContent).toContain('No backend is connected yet.');
  });
});

describe('MetricCard', () => {
  it('shows "No signal yet" instead of a fabricated zero when the value is missing', () => {
    render(<MetricCard label="Agents running" value={null} meta="67% capacity" />);
    expect(screen.getByText('No signal yet')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText('67% capacity')).toBeNull();
  });

  it('shows value, unit and meta when a signal exists', () => {
    render(<MetricCard label="Token burn rate" value="4.8" unit="K/s" meta="vs. yesterday" />);
    expect(screen.getByText('4.8')).toBeTruthy();
    expect(screen.getByText('vs. yesterday')).toBeTruthy();
  });
});
