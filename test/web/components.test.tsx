import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DECISION_SUPPORT_LABEL,
  ErrorBanner,
  GatedValue,
  LoadingIndicator,
  NO_SOH_HISTORY_TEXT,
  PathwayBadge,
  SohChart,
  StatusMessage,
  VALIDATION_NOTICE_TEXT,
  ValidationNotice,
  WithheldMarker,
} from '../../src/web/components';
import { WITHHELD_REASON, withheld, type Gated } from '../../src/core/projection';

describe('ValidationNotice', () => {
  it('renders the exact notice text', () => {
    render(<ValidationNotice id="vn" />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/^Certified specialist validation required$/);
    expect(note).toHaveAttribute('id', 'vn');
    expect(VALIDATION_NOTICE_TEXT).toBe('Certified specialist validation required');
  });
});

describe('PathwayBadge', () => {
  it('shows the Decision support label and no notice for Continue_Use', () => {
    render(<PathwayBadge pathway="Continue_Use" />);
    expect(screen.getByTestId('pathway-name')).toHaveTextContent('Continue Use');
    expect(screen.getByText(DECISION_SUPPORT_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(VALIDATION_NOTICE_TEXT)).not.toBeInTheDocument();
  });

  it.each(['Second_Life_Review', 'Certified_Recycling'] as const)(
    'places the Validation_Notice adjacent to the %s name',
    (pathway) => {
      render(<PathwayBadge pathway={pathway} />);
      const name = screen.getByTestId('pathway-name');
      // Adjacent: same row, immediately after the name.
      expect(name.nextElementSibling).toHaveTextContent(VALIDATION_NOTICE_TEXT);
      expect(screen.getByText(DECISION_SUPPORT_LABEL)).toBeInTheDocument();
    },
  );

  it('adds the notice next to routed and end-of-life pathways', () => {
    render(
      <PathwayBadge
        pathway="Inspect_Repair"
        routedPathway="Certified_Recycling"
        eolPathway="Second_Life_Review"
        reason="Telemetry is missing"
      />,
    );
    expect(screen.getByTestId('routed-pathway-name').nextElementSibling).toHaveTextContent(VALIDATION_NOTICE_TEXT);
    expect(screen.getByTestId('eol-pathway-name').nextElementSibling).toHaveTextContent(VALIDATION_NOTICE_TEXT);
    expect(screen.getAllByText(VALIDATION_NOTICE_TEXT)).toHaveLength(2);
    expect(screen.getByText('Reason: Telemetry is missing')).toBeInTheDocument();
  });

  it('shows data confidence and consent as separate fields', () => {
    render(<PathwayBadge pathway="Continue_Use" dataConfidence={85} consentStatus="not_granted" />);
    expect(screen.getByText('Data confidence: 85/100')).toBeInTheDocument();
    expect(screen.getByText('Consent: not granted')).toBeInTheDocument();
  });

  it('reveals fired rules via a keyboard-operable disclosure', async () => {
    const user = userEvent.setup();
    render(
      <PathwayBadge
        pathway="Second_Life_Review"
        decidingRule="SECOND_LIFE_REVIEW"
        firedRules={[{ rule: 'SECOND_LIFE_REVIEW', inputs: { soh: 72 } }]}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Why this pathway' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Rules that fired' })).not.toBeInTheDocument();
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Rules that fired' });
    expect(within(list).getByText(/Second-life review rule \(SoH 72%\) — deciding rule/)).toBeInTheDocument();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('WithheldMarker and GatedValue', () => {
  it('renders the withheld reason with an optional field label', () => {
    render(<WithheldMarker label="Health_Score" />);
    const marker = screen.getByTestId('withheld-marker');
    expect(marker).toHaveTextContent(`Health_Score: ${WITHHELD_REASON}`);
  });

  it('renders the marker in place of a withheld value', () => {
    const value: Gated<number> = withheld();
    render(<GatedValue<number> value={value} label="SoH" render={(v) => <span>{v}%</span>} />);
    expect(screen.getByTestId('withheld-marker')).toHaveTextContent(WITHHELD_REASON);
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  it('renders the value when not withheld', () => {
    render(<GatedValue<number> value={73} render={(v) => <span>{v}%</span>} />);
    expect(screen.getByText('73%')).toBeInTheDocument();
    expect(screen.queryByTestId('withheld-marker')).not.toBeInTheDocument();
  });
});

describe('ErrorBanner', () => {
  it('announces the failed operation and lists invalid fields', () => {
    render(
      <ErrorBanner
        operation="Logging repair"
        message="Validation failed"
        fields={[
          { field: 'date', message: 'Date is later than today' },
          { field: 'actionTaken', message: 'Required' },
        ]}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Error: Logging repair failed: Validation failed');
    const list = within(alert).getByRole('list', { name: 'Invalid fields' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list).toHaveTextContent('date: Date is later than today');
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('has a keyboard-operable dismiss button when onDismiss is given', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<ErrorBanner operation="Saving consent" message="timeout" onDismiss={onDismiss} />);
    await user.tab();
    const btn = screen.getByRole('button', { name: 'Dismiss Saving consent error' });
    expect(btn).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});

describe('LoadingIndicator and StatusMessage', () => {
  it('exposes a status region with an accessible name', () => {
    render(<LoadingIndicator />);
    expect(screen.getByRole('status', { name: 'Loading battery data' })).toBeInTheDocument();
  });

  it('accepts a custom label', () => {
    render(<LoadingIndicator label="Loading report" />);
    expect(screen.getByRole('status', { name: 'Loading report' })).toBeInTheDocument();
  });

  it('StatusMessage is a polite live region', () => {
    render(<StatusMessage>Return accepted, +25 Impact points</StatusMessage>);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Return accepted, +25 Impact points');
  });
});

describe('SohChart', () => {
  const series = [
    { timestamp: '2025-03-01T00:00:00.000Z', sohPct: 88 },
    { timestamp: '2025-01-01T00:00:00.000Z', sohPct: 90 },
    { timestamp: '2025-06-01T00:00:00.000Z', sohPct: 85.5 },
  ];

  it('shows the no-history message when empty', () => {
    render(<SohChart series={[]} batteryId="BR-0001" />);
    expect(screen.getByText(NO_SOH_HISTORY_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders one point per reading with an accessible name', () => {
    render(<SohChart series={series} batteryId="BR-0001" />);
    const img = screen.getByRole('img', { name: /State of health over time for BR-0001/ });
    expect(img).toHaveAccessibleName(expect.stringContaining('3 readings from 2025-01-01 (90%) to 2025-06-01 (85.5%)'));
    expect(screen.getAllByTestId('soh-point')).toHaveLength(3);
  });

  it('provides a data table text alternative in timestamp-ascending order', () => {
    render(<SohChart series={series} batteryId="BR-0001" />);
    const table = screen.getByRole('table', { name: 'State of health readings for BR-0001' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[1]!.textContent)).toEqual(['90', '88', '85.5']);
  });

  it('handles a single reading', () => {
    render(<SohChart series={[series[0]!]} />);
    expect(screen.getAllByTestId('soh-point')).toHaveLength(1);
    expect(screen.getByRole('img')).toHaveAccessibleName(expect.stringContaining('1 reading from'));
  });
});
