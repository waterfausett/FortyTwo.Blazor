import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewMatchDialog } from './NewMatchDialog';

afterEach(cleanup);

describe('NewMatchDialog', () => {
  it('offers Live Play, Async and Custom Match, and reports the choice', () => {
    const onChoose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={false} onChoose={onChoose} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /live play/i }));
    fireEvent.click(screen.getByRole('button', { name: /async/i }));
    fireEvent.click(screen.getByRole('button', { name: /custom match/i }));
    expect(onChoose.mock.calls).toEqual([['live'], ['daily'], ['challenge']]);
    expect(screen.getByText(/kicked if away for a full hand/)).toBeTruthy();
  });

  it('groups the matchmade options apart from playing with friends', () => {
    render(<NewMatchDialog open liveEnabled online={null} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    const matchmade = screen.getByRole('group', { name: /find opponents/i });
    expect(within(matchmade).getByRole('button', { name: /live play/i })).toBeTruthy();
    expect(within(matchmade).getByRole('button', { name: /async/i })).toBeTruthy();
    const friends = screen.getByRole('group', { name: /play with friends/i });
    expect(within(friends).getByRole('button', { name: /custom match/i })).toBeTruthy();
  });

  it('leaves Live Play out when bots are off', () => {
    render(<NewMatchDialog open liveEnabled={false} online={null} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /live play/i })).toBeNull();
  });

  it('offers Play vs bots under Practice', () => {
    const onChoose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={false} onChoose={onChoose} onClose={vi.fn()} />);
    const practice = screen.getByRole('group', { name: /practice/i });
    fireEvent.click(within(practice).getByRole('button', { name: /play vs bots/i }));
    expect(onChoose).toHaveBeenCalledWith('bots');
    expect(screen.getByText('Jump straight in against three bots.')).toBeTruthy();
  });

  it('leaves Play vs bots out when bots are off', () => {
    render(<NewMatchDialog open liveEnabled={false} online={null} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: /practice/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /play vs bots/i })).toBeNull();
  });

  it('disables Play vs bots while a match is starting', () => {
    render(<NewMatchDialog open liveEnabled online={null} pending onChoose={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByRole('button', { name: /play vs bots/i }) as HTMLButtonElement).disabled).toBe(true);
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
