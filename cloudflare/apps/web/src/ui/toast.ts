// SweetAlert2 toasts for errors and notices: a small card in the bottom-right corner that times out on its own and pauses while hovered.
// Styled to the hall palette in styles/toast.css.
import Swal, { type SweetAlertPosition } from 'sweetalert2';
import { ApiError } from '../api/client';
import '../styles/toast.css';

const Toast = Swal.mixin({
  toast: true,
  position: 'bottom-end',
  showConfirmButton: false,
  showCloseButton: true,
  timer: 3000,
  timerProgressBar: true,
  customClass: { popup: 'hall-toast' },
  didOpen: (toast) => {
    toast.addEventListener('mouseenter', Swal.stopTimer);
    toast.addEventListener('mouseleave', Swal.resumeTimer);
  },
});

// The rules engine's messages wrap the name of a bid or suit in `<code>` (validation.ts). Build
// that one tag as a real element and
// everything else as plain text, so no server string is ever parsed as HTML.
function formatDetail(detail: string): HTMLElement {
  const container = document.createElement('span');
  for (const [i, part] of detail.split(/<code>(.*?)<\/code>/).entries()) {
    if (i % 2 === 0) {
      container.append(part);
    } else {
      const code = document.createElement('code');
      code.textContent = part;
      container.append(code);
    }
  }
  return container;
}

export function toastError(error: unknown): void {
  if (error instanceof ApiError) {
    void Toast.fire({ icon: 'error', title: error.title, html: error.detail && formatDetail(error.detail) });
  } else {
    void Toast.fire({
      icon: 'error',
      title: error instanceof Error ? error.message : 'Something went wrong.',
    });
  }
}

// A heads-up rather than an error - e.g. the next hand being dealt while you looked away. Turn
// notifications (#2) can build on this.
export function toastInfo(title: string, text?: string, position: SweetAlertPosition = 'bottom-end'): void {
  void Toast.fire({
    icon: 'info',
    title,
    text,
    position,
    customClass: { popup: 'hall-toast hall-toast--info' },
  });
}
