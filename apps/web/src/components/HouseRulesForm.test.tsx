import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HOUSE_RULES } from '@fortytwo/rules';
import { HouseRulesForm } from './HouseRulesForm';

afterEach(cleanup);

describe('HouseRulesForm', () => {
  it('shows the defaults selected', () => {
    render(<HouseRulesForm rules={DEFAULT_HOUSE_RULES} onChange={vi.fn()} />);
    expect((screen.getByRole('radio', { name: 'On' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /plunge/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /last player must bid/i }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('reports each change', () => {
    const onChange = vi.fn();
    render(<HouseRulesForm rules={DEFAULT_HOUSE_RULES} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /plunge/i }));
    fireEvent.click(screen.getByRole('button', { name: /more marks/i }));
    expect(onChange.mock.calls).toEqual([
      [{ ...DEFAULT_HOUSE_RULES, low: 'off' }],
      [{ ...DEFAULT_HOUSE_RULES, plunge: false }],
      [{ ...DEFAULT_HOUSE_RULES, marksToWin: 8 }],
    ]);
  });

  it('moves Low forced bid only to On when Reshuffle is picked, and disables it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<HouseRulesForm rules={{ ...DEFAULT_HOUSE_RULES, low: 'forcedOnly' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /reshuffle/i }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_HOUSE_RULES, allPass: 'redeal' });

    rerender(<HouseRulesForm rules={{ ...DEFAULT_HOUSE_RULES, allPass: 'redeal' }} onChange={onChange} />);
    expect((screen.getByRole('radio', { name: /forced bid only/i }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/aren't available when forced bidding is disabled/i)).toBeTruthy();
  });

  it('stops the marks stepper at 1 and 21', () => {
    const { rerender } = render(<HouseRulesForm rules={{ ...DEFAULT_HOUSE_RULES, marksToWin: 1 }} onChange={vi.fn()} />);
    expect((screen.getByRole('button', { name: /fewer marks/i }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<HouseRulesForm rules={{ ...DEFAULT_HOUSE_RULES, marksToWin: 21 }} onChange={vi.fn()} />);
    expect((screen.getByRole('button', { name: /more marks/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
