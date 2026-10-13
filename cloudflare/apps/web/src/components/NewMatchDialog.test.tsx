import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewMatchDialog } from './NewMatchDialog';

afterEach(cleanup);

describe('NewMatchDialog', () => {
  it('offers Over the table, Daily and Challenge friends, and reports the choice', () => {
    const onChoose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={false} onChoose={onChoose} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /over the table/i }));
    fireEvent.click(screen.getByRole('button', { name: /daily/i }));
    fireEvent.click(screen.getByRole('button', { name: /challenge friends/i }));
    expect(onChoose.mock.calls).toEqual([['live'], ['daily'], ['challenge']]);
    expect(screen.getByText(/new players take over bots' seats between hands/)).toBeTruthy();
  });

  it('groups the matchmade options apart from playing with friends', () => {
    render(<NewMatchDialog open liveEnabled online={null} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    const matchmade = screen.getByRole('group', { name: /find opponents/i });
    expect(within(matchmade).getByRole('button', { name: /over the table/i })).toBeTruthy();
    expect(within(matchmade).getByRole('button', { name: /daily/i })).toBeTruthy();
    const friends = screen.getByRole('group', { name: /play with friends/i });
    expect(within(friends).getByRole('button', { name: /challenge friends/i })).toBeTruthy();
  });

  it('leaves Over the table out when bots are off', () => {
    render(<NewMatchDialog open liveEnabled={false} online={null} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /over the table/i })).toBeNull();
  });

  it('renders nothing while closed', () => {
    render(<NewMatchDialog open={false} liveEnabled online={null} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says how many players are online', () => {
    render(<NewMatchDialog open liveEnabled online={5} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('5 online')).toBeTruthy();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={false} onChoose={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
