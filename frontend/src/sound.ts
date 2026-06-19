// Lightweight synthesized sound effects — no audio assets. The AudioContext is
// created lazily and unlocked on the first user gesture, so server-triggered
// sounds (e.g. another player challenging) can play too. All sounds are short
// and quiet by design.

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// Browsers block audio until a user gesture — prime the context on the first one.
let unlocked = false;
function unlock() {
  if (unlocked) return;
  unlocked = true;
  ensureCtx();
  window.removeEventListener("pointerdown", unlock);
  window.removeEventListener("keydown", unlock);
}
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

/** Light mobile haptic feedback — no-op where the Vibration API is unsupported
 *  (desktop, iOS Safari) or denied. */
export function haptic(pattern: number | number[] = 12): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* ignore */
  }
}

interface Blip {
  freq: number;
  to?: number; // glide target frequency
  type?: OscillatorType;
  dur?: number;
  gain?: number;
  delay?: number;
}
function blip({ freq, to, type = "triangle", dur = 0.08, gain = 0.12, delay = 0 }: Blip) {
  const c = ensureCtx();
  if (!c || c.state !== "running") return; // not unlocked yet → stay silent
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Soft wooden "tock" when a tile is placed — pitch rises with the stack height
 *  it lands on, so taller stacks sound higher (height 1 = lowest). */
export function playPlace(height = 1): void {
  const h = Math.max(1, Math.min(height, 5));
  const base = 200 + (h - 1) * 72;
  blip({ freq: base, to: base * 0.62, type: "triangle", dur: 0.07, gain: 0.24 });
}

/** Soft reverse "tock" when a tile is pulled back to the rack or rearranged. */
export function playRecall(): void {
  blip({ freq: 150, to: 230, type: "triangle", dur: 0.06, gain: 0.16 });
}

/** Big ascending arpeggio when a player uses all 7 tiles (bingo, +20). */
export function playBingo(): void {
  const notes = [523, 659, 784, 1047, 1319]; // C5 E5 G5 C6 E6
  notes.forEach((f, i) => blip({ freq: f, type: "triangle", dur: 0.16, gain: 0.12, delay: i * 0.07 }));
  blip({ freq: 1568, type: "sine", dur: 0.3, gain: 0.1, delay: notes.length * 0.07 }); // sparkle G6
}

/** Quick run of rising blips when a move scores — more blips for more points. */
export function playScoreTally(points: number): void {
  const n = Math.max(2, Math.min(Math.round(points / 3), 7));
  for (let i = 0; i < n; i++) {
    blip({ freq: 520 + i * 60, type: "sine", dur: 0.05, gain: 0.07, delay: 0.28 + i * 0.05 });
  }
}

/** Bright little sparkle when the Qu bonus tile is played. */
export function playQu(): void {
  blip({ freq: 988, to: 1319, type: "sine", dur: 0.1, gain: 0.1 });
  blip({ freq: 1319, to: 1760, type: "sine", dur: 0.12, gain: 0.09, delay: 0.08 });
}

/** Gentle two-note rise when it becomes your turn. */
export function playYourTurn(): void {
  blip({ freq: 587, to: 660, type: "sine", dur: 0.11, gain: 0.11 }); // D5
  blip({ freq: 880, type: "sine", dur: 0.18, gain: 0.12, delay: 0.11 }); // A5
}

/** Triumphant flourish on the end screen when you win (or tie for the lead). */
export function playWin(): void {
  [523, 659, 784, 1047].forEach((f, i) =>
    blip({ freq: f, type: "triangle", dur: 0.18, gain: 0.12, delay: i * 0.1 }),
  );
}

/** Soft descending tone on the end screen when you don't win. */
export function playLose(): void {
  blip({ freq: 440, to: 392, type: "sine", dur: 0.22, gain: 0.1 });
  blip({ freq: 349, to: 294, type: "sine", dur: 0.34, gain: 0.1, delay: 0.2 });
}

/** Attention-grabbing two-tone when a player challenges a word. */
export function playChallenge(): void {
  blip({ freq: 480, to: 360, type: "square", dur: 0.12, gain: 0.09 });
  blip({ freq: 320, to: 220, type: "square", dur: 0.16, gain: 0.09, delay: 0.12 });
}

/** Gentle single "boop-up" when a player submits their turn. */
export function playSubmit(): void {
  blip({ freq: 440, to: 600, type: "sine", dur: 0.13, gain: 0.13 });
}

/** Cheerful ascending major triad when a move is accepted (committed). */
export function playAccepted(): void {
  blip({ freq: 523, type: "sine", dur: 0.1, gain: 0.11 }); // C5
  blip({ freq: 659, type: "sine", dur: 0.1, gain: 0.11, delay: 0.09 }); // E5
  blip({ freq: 784, type: "sine", dur: 0.18, gain: 0.12, delay: 0.18 }); // G5
}

/** Somber descending two-tone when a move is rejected by challenge. */
export function playRejected(): void {
  blip({ freq: 300, to: 240, type: "sawtooth", dur: 0.16, gain: 0.1 });
  blip({ freq: 200, to: 150, type: "sawtooth", dur: 0.26, gain: 0.1, delay: 0.16 });
}
