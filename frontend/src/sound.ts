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

/** Soft wooden "tock" when a tile is placed on the board. */
export function playPlace(): void {
  blip({ freq: 230, to: 150, type: "triangle", dur: 0.07, gain: 0.14 });
}

/** Attention-grabbing two-tone when a player challenges a word. */
export function playChallenge(): void {
  blip({ freq: 480, to: 360, type: "square", dur: 0.12, gain: 0.09 });
  blip({ freq: 320, to: 220, type: "square", dur: 0.16, gain: 0.09, delay: 0.12 });
}
