// The turn chime (match/TurnAlerts.tsx): two soft rising notes, made with Web Audio so there's no
// sound file to ship.
//
// Browsers keep audio locked until the page has had a click or key press, and a chime is most
// useful when the player is away and can't give one - so `unlockChimeOnGesture` wakes the audio
// on the first gesture it sees, ready for later. Without that (or Web Audio at all) the chime just
// stays silent.

// A major third, E5 then G#5.
const NOTES_HZ = [659.25, 830.61];
const NOTE_GAP_S = 0.16;
const NOTE_LENGTH_S = 0.5;
const VOLUME = 0.18;

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context) return context;
  if (typeof AudioContext === 'undefined') return null;
  try {
    context = new AudioContext();
  } catch {
    return null;
  }
  return context;
}

function wake(ctx: AudioContext): void {
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

export function playChime(): void {
  const ctx = audioContext();
  if (!ctx) return;
  wake(ctx);
  NOTES_HZ.forEach((hz, i) => {
    const at = ctx.currentTime + i * NOTE_GAP_S;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(hz, at);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(VOLUME, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, at + NOTE_LENGTH_S);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + NOTE_LENGTH_S);
  });
}

const GESTURES = ['pointerdown', 'keydown'] as const;

export function unlockChimeOnGesture(): void {
  function unlock(): void {
    for (const gesture of GESTURES) window.removeEventListener(gesture, unlock);
    const ctx = audioContext();
    if (ctx) wake(ctx);
  }
  for (const gesture of GESTURES) window.addEventListener(gesture, unlock);
}
