import Swal from 'sweetalert2';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@fortytwo/rules';
import { ApiError } from '../api/client';
import { toastError, toastInfo } from './toast';

// jsdom has no matchMedia; SweetAlert2's icons read the color scheme through it.
beforeAll(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
});

afterEach(() => {
  Swal.close();
});

describe('toastError', () => {
  it("shows an API error's title and detail separately", () => {
    toastError(new ApiError('You must follow suit!', 'If you have a Six, you must play it'));

    expect(Swal.getTitle()?.textContent).toBe('You must follow suit!');
    expect(Swal.getHtmlContainer()?.textContent).toBe('If you have a Six, you must play it');
    expect(Swal.getPopup()?.classList.contains('hall-toast')).toBe(true);
  });

  it('renders the rules engine\'s <code> tags as elements and everything else as text', () => {
    toastError(new ApiError('You must follow suit!', 'If you have a <code>Six</code>, <b>you</b> must play it'));

    const container = Swal.getHtmlContainer()!;
    expect(container.textContent).toBe('If you have a Six, <b>you</b> must play it');
    expect(container.querySelector('code')?.textContent).toBe('Six');
    expect(container.querySelector('b')).toBeNull();
  });

  it('shows a rule caught here first the same as the server\'s', () => {
    toastError(new ValidationError('You must follow suit!', 'If you have a <code>Six</code>, you must play it'));

    expect(Swal.getTitle()?.textContent).toBe('You must follow suit!');
    expect(Swal.getHtmlContainer()?.querySelector('code')?.textContent).toBe('Six');
  });

  it("falls back to a plain Error's message as the title", () => {
    toastError(new Error('Network down'));

    expect(Swal.getTitle()?.textContent).toBe('Network down');
  });
});

describe('toastInfo', () => {
  it('shows an info toast with the given title and text', () => {
    toastInfo('Game 4 dealt', 'Alice bids first');

    expect(Swal.getTitle()?.textContent).toBe('Game 4 dealt');
    expect(Swal.getHtmlContainer()?.textContent).toBe('Alice bids first');
    expect(Swal.getIcon()?.classList.contains('swal2-info')).toBe(true);
    expect(Swal.getPopup()?.classList.contains('hall-toast')).toBe(true);
  });
});
