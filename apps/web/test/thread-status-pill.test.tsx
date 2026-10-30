// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { agentStatusText, reasonWords } from '@/components/dashboard/format';
import { ThreadStatusPill } from '@/components/dashboard/signal';

// ADR-0017 §6, TEST_PLAN §S5d (pill rows): the agent's own report is named in words, with its
// reason, as the pill's text. No screenshots (budget 0).

afterEach(cleanup);

/** The rendered pill and the text a screen reader gets from it (aria-hidden parts removed). */
const pill = (ui: ReactElement) => {
  const { container } = render(ui);
  const el = container.firstElementChild as HTMLElement;
  const clone = el.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return { el, spoken: clone.textContent?.trim() ?? '' };
};

describe('ThreadStatusPill with an agent report', () => {
  it('reads "Blocked · missing credentials · reported by agent", visibly and to screen readers', () => {
    const { el, spoken } = pill(
      <ThreadStatusPill status="blocked" source="agent" reason="missing_credentials" />,
    );
    expect(el.textContent).toBe('Blocked · missing credentials · reported by agent');
    expect(spoken).toBe('Blocked · missing credentials · reported by agent');
    // Colour is a second channel only: the tone class sits next to the words.
    expect(el.className).toContain('text-danger');
    expect(el.querySelector('[aria-hidden="true"]')?.textContent).toBe('');
  });

  it('omits the reason segment when the agent gave none (or it was not a listed reason)', () => {
    expect(pill(<ThreadStatusPill status="completed" source="agent" reason={null} />).spoken).toBe(
      'Completed · reported by agent',
    );
    expect(pill(<ThreadStatusPill status="working" source="agent" />).spoken).toBe(
      'Working · reported by agent',
    );
  });

  it('keeps the warm status label and turns underscores into spaces', () => {
    expect(
      pill(<ThreadStatusPill status="waiting" source="agent" reason="needs_input" />).spoken,
    ).toBe('Waiting for you · needs input · reported by agent');
    expect(
      pill(<ThreadStatusPill status="failed" source="agent" reason="conflicting_requirements" />)
        .spoken,
    ).toBe('Failed · conflicting requirements · reported by agent');
  });

  it('still reads "Ended" for a waiting thread that no longer needs anyone', () => {
    const { spoken } = pill(
      <ThreadStatusPill status="waiting" needsAttention={false} source="agent" reason="other" />,
    );
    expect(spoken).toBe('Ended');
  });
});

describe('ThreadStatusPill without an agent report', () => {
  it('shows the plain label for collector statuses, never "reported by agent"', () => {
    expect(
      pill(<ThreadStatusPill status="blocked" source="collector" reason={null} />).spoken,
    ).toBe('Blocked');
    expect(pill(<ThreadStatusPill status="idle" />).spoken).toBe('Idle');
  });

  it('says "No status sent" when there is no status', () => {
    expect(pill(<ThreadStatusPill status={null} source="agent" />).spoken).toBe('No status sent');
  });
});

describe('reason words', () => {
  it('lower-cases and spaces every listed reason', () => {
    expect(reasonWords('missing_credentials')).toBe('missing credentials');
    expect(reasonWords('ci_failing')).toBe('CI failing');
    expect(reasonWords('other')).toBe('other');
    expect(agentStatusText('blocked', 'rate_limited')).toBe(
      'Blocked · rate limited · reported by agent',
    );
  });
});
