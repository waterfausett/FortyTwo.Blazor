import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiError } from '@fortytwo/client';
import { ToastHost } from '../ToastHost';
import { TOAST_DURATION_MS, parseDetail, resetToasts, subscribeToasts, toastError, toastInfo, type Toast } from '../toast';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

beforeEach(() => {
  jest.useFakeTimers();
  resetToasts();
});
afterEach(() => {
  resetToasts();
  jest.useRealTimers();
});

describe('parseDetail', () => {
  it("picks out the bid or suit a rule message wraps in <code>, and nothing else", () => {
    expect(parseDetail('If you have a <code>Six</code> you must play it.')).toEqual([
      { text: 'If you have a ', emphasis: false },
      { text: 'Six', emphasis: true },
      { text: ' you must play it.', emphasis: false },
    ]);
    expect(parseDetail('<b>not</b> markup')).toEqual([{ text: '<b>not</b> markup', emphasis: false }]);
    expect(parseDetail(undefined)).toEqual([]);
  });
});

describe('toasts', () => {
  let shown: Toast[] = [];
  beforeEach(() => subscribeToasts((t) => (shown = t)));

  it('times out on its own', () => {
    toastInfo('Game 2 dealt', 'You bid first', 'center');
    expect(shown.map((t) => [t.title, t.position])).toEqual([['Game 2 dealt', 'center']]);
    // The store alone, no React: so no act().
    jest.advanceTimersByTime(TOAST_DURATION_MS);
    expect(shown).toEqual([]);
  });

  it('keeps at most three, dropping the oldest', () => {
    for (const n of [1, 2, 3, 4]) toastError(new Error(`Error ${n}`));
    expect(shown.map((t) => t.title)).toEqual(['Error 2', 'Error 3', 'Error 4']);
  });
});

describe('ToastHost', () => {
  it("shows an API error's title and detail, and dismisses it on tap", async () => {
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastHost />
      </SafeAreaProvider>
    );
    await act(async () => toastError(new ApiError('Invalid play', 'You must follow <code>Fives</code>.')));
    // Past the fade-in.
    await act(async () => {
      jest.advanceTimersByTime(250);
    });

    expect(screen.getByText('Invalid play')).toBeTruthy();
    expect(screen.getByText('Fives')).toBeTruthy();
    await fireEvent.press(screen.getByText('Invalid play'));
    expect(screen.queryByText('Invalid play')).toBeNull();
  });
});
