import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewMatchDialog, SLOW_MS } from './NewMatchDialog';

afterEach(cleanup);

describe('NewMatchDialog', () => {
  it('offers Live Play, Async and Custom Match, and reports the choice', () => {
    const onChoose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={null} error={null} onChoose={onChoose} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /live play/i }));
    fireEvent.click(screen.getByRole('button', { name: /async/i }));
    fireEvent.click(screen.getByRole('button', { name: /custom match/i }));
    expect(onChoose.mock.calls).toEqual([['live'], ['daily'], ['challenge']]);
    expect(screen.getByText(/kicked if away for a full hand/)).toBeTruthy();
  });

  it('groups the matchmade options apart from playing with friends', () => {
    render(<NewMatchDialog open liveEnabled online={null} pending={null} error={null} onChoose={vi.fn()} onClose={vi.fn()} />);
    const matchmade = screen.getByRole('group', { name: /find opponents/i });
    expect(within(matchmade).getByRole('button', { name: /live play/i })).toBeTruthy();
    expect(within(matchmade).getByRole('button', { name: /async/i })).toBeTruthy();
    const friends = screen.getByRole('group', { name: /play with friends/i });
    expect(within(friends).getByRole('button', { name: /custom match/i })).toBeTruthy();
  });

  it('leaves Live Play out when bots are off', () => {
    render(<NewMatchDialog open liveEnabled={false} online={null} pending={null} error={null} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /live play/i })).toBeNull();
  });

  it('offers Play vs bots under Practice', () => {
    const onChoose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={null} error={null} onChoose={onChoose} onClose={vi.fn()} />);
    const practice = screen.getByRole('group', { name: /practice/i });
    fireEvent.click(within(practice).getByRole('button', { name: /play vs bots/i }));
    expect(onChoose).toHaveBeenCalledWith('bots');
    expect(screen.getByText('Jump straight in against three bots.')).toBeTruthy();
  });

  it('leaves Play vs bots out when bots are off', () => {
    render(<NewMatchDialog open liveEnabled={false} online={null} pending={null} error={null} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: /practice/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /play vs bots/i })).toBeNull();
  });

  it('says Play vs bots is setting up the table while it works', () => {
    render(<NewMatchDialog open liveEnabled online={null} pending="bots" error={null} onChoose={vi.fn()} onClose={vi.fn()} />);
    const working = screen.getByRole('button', { name: /play vs bots.*setting up the table/i }) as HTMLButtonElement;
    expect(working.disabled).toBe(true);
  });

  it('renders nothing while closed', () => {
    render(<NewMatchDialog open={false} liveEnabled online={null} pending={null} error={null} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says how many players are online', () => {
    render(<NewMatchDialog open liveEnabled online={5} pending={null} error={null} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('5 online')).toBeTruthy();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={null} error={null} onChoose={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
  it('shows which choice is working, and says so when it takes a while', () => {
    vi.useFakeTimers();
    try {
      render(<NewMatchDialog open liveEnabled online={null} pending="daily" error={null} onChoose={vi.fn()} onClose={vi.fn()} />);
      const working = screen.getByRole('button', { name: /async/i });
      expect(working.getAttribute('aria-busy')).toBe('true');
      expect(working.textContent).toMatch(/finding a seat/i);
      expect((screen.getByRole('button', { name: /custom match/i }) as HTMLButtonElement).disabled).toBe(true);

      act(() => vi.advanceTimersByTime(SLOW_MS));
      expect(working.textContent).toMatch(/still working/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays open while a choice is working', () => {
    const onClose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending="challenge" error={null} onChoose={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows why the last choice failed', () => {
    render(<NewMatchDialog open liveEnabled online={null} pending={null} error="Request timed out" onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('Request timed out');
  });
});
