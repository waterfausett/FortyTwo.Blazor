// Toasts for errors and notices, like the web's (apps/web/src/ui/toast.ts): a small card that times
// out on its own. Callable from anywhere - a mutation's onError, say - and shown by the ToastHost
// in the root layout, which subscribes here.
import { ApiError } from '@fortytwo/client';
import { ValidationError } from '@fortytwo/rules';

export const TOAST_DURATION_MS = 3000;
// Older toasts are dropped once this many are showing.
const MAX_SHOWN = 3;

// Plain text, with the bid or suit a rule message names marked to stand out.
export interface DetailPart {
  text: string;
  emphasis: boolean;
}

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  title: string;
  detail: DetailPart[];
  // Errors sit near the top, clear of the player's hand; a notice can take the middle of the screen.
  position: 'top' | 'center';
}

// The rules engine's messages wrap the name of a bid or suit in `<code>` (validation.ts). That one
// tag becomes emphasis; everything else stays plain text.
export function parseDetail(detail: string | undefined): DetailPart[] {
  if (!detail) return [];
  return detail
    .split(/<code>(.*?)<\/code>/)
    .map((text, i) => ({ text, emphasis: i % 2 === 1 }))
    .filter((part) => part.text !== '');
}

type Listener = (toasts: Toast[]) => void;
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener(toasts);
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function show(toast: Omit<Toast, 'id'>): number {
  const id = nextId++;
  const dropped = toasts.length >= MAX_SHOWN ? toasts.slice(0, toasts.length - MAX_SHOWN + 1) : [];
  for (const old of dropped) {
    const timer = timers.get(old.id);
    if (timer) clearTimeout(timer);
    timers.delete(old.id);
  }
  toasts = [...toasts.slice(dropped.length), { ...toast, id }];
  timers.set(
    id,
    setTimeout(() => dismissToast(id), TOAST_DURATION_MS)
  );
  emit();
  return id;
}

export function toastError(error: unknown): void {
  // A rule broken on the server, or caught here first by the same rules.
  if (error instanceof ApiError || error instanceof ValidationError) {
    show({ kind: 'error', title: error.title, detail: parseDetail(error.detail), position: 'top' });
  } else {
    show({
      kind: 'error',
      title: error instanceof Error ? error.message : 'Something went wrong.',
      detail: [],
      position: 'top',
    });
  }
}

// A heads-up rather than an error - e.g. the next hand being dealt while you looked away.
export function toastInfo(title: string, text?: string, position: Toast['position'] = 'top'): void {
  show({ kind: 'info', title, detail: text ? [{ text, emphasis: false }] : [], position });
}

// For tests: start from nothing.
export function resetToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  toasts = [];
  emit();
}
