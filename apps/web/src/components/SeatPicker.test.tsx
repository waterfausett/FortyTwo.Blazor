// SeatPicker.tsx: a taken seat shows a skeleton only while its own name loads, so names that have
// already arrived stay visible.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeatPicker } from './SeatPicker';

afterEach(cleanup);

describe('SeatPicker', () => {
  it('keeps a loaded seat name visible while another seat loads', () => {
    render(
      <SeatPicker seats={['Ann', '', null, 'Di']} loading={[false, true, false, false]} disabled={false} onPick={vi.fn()} />
    );

    expect(screen.getByText('Ann')).toBeTruthy();
    expect(screen.getAllByText('Loading name')).toHaveLength(1);
  });
});
