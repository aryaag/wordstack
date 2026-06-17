import { useEffect, useRef, useState } from "react";
import { DEFAULT_CONFIG, extractWords } from "../../worker/src/engine";
import type { DefineResult, PlayerState, PublicState, TurnRecord } from "../../worker/src/protocol";
import { fetchDefinition } from "./useRoom";
import { AVATAR_COLORS, avatarLabel, displayLetter, Icon, initials, Tile, TimerRing } from "./lib";
import { playLose, playWin } from "./sound";

const FALLBACK = { bg: "#D3D1C7", fg: "#444" };
const colorOf = (p?: PlayerState) => (p ? AVATAR_COLORS[p.seat % 4] : FALLBACK);

export interface InspectLayer {
  letter: string;
  by?: string;
  across?: string;
  down?: string;
}

const whenLabel = (i: number) => (i === 0 ? "just now" : `${i} turn${i > 1 ? "s" : ""} ago`);

/** Single ring around the active player's avatar showing time LEFT in the turn:
 *  it starts full and depletes counter-clockwise, pulsing in the final minute. */
const TURN_SOFT_MS = 600_000; // 10 min soft turn limit
const TURN_PULSE_MS = 60_000; // pulse in the last minute
function TurnRing({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  const remainingMs = Math.max(0, TURN_SOFT_MS - (now - startedAt));
  const frac = remainingMs / TURN_SOFT_MS; // 1 = full ring, 0 = empty
  const r = 22;
  const circ = 2 * Math.PI * r;
  const pulsing = remainingMs <= TURN_PULSE_MS;
  return (
    <svg className={`turn-ring${pulsing ? " pulsing" : ""}`} width="48" height="48" viewBox="0 0 48 48" aria-hidden>
      <circle
        cx="24"
        cy="24"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circ.toFixed(1)}
        strokeDashoffset={(circ * (1 - frac)).toFixed(1)}
        // rotate to start at top, mirror so it depletes counter-clockwise
        transform="rotate(-90 24 24) scale(-1 1) translate(-48 0)"
      />
    </svg>
  );
}

// ── Compact player strip (avatar circles + score + turn ring), always on top ──
export function PlayerStrip({ state, me, onHistory }: { state: PublicState; me: string; onHistory: () => void }) {
  const current = state.players[state.turnSeat];
  const names = state.players.map((p) => p.name);
  const inPlay = state.phase === "playing" || state.phase === "pending";
  // Fix the circles to this game's play order — the player who took the first
  // turn stays leftmost — so the strip doesn't reshuffle every turn.
  const start = state.firstSeat ?? 0;
  const ordered = [...state.players.slice(start), ...state.players.slice(0, start)];
  return (
    <div className="pstrip">
      {ordered.map((p) => {
        const col = colorOf(p);
        const isCurrent = p.id === current?.id && state.phase !== "gameover";
        return (
          <div
            key={p.id}
            className={`pcell${isCurrent ? " active" : ""}${p.left ? " gone" : ""}`}
            title={p.left ? `${p.name} (left)` : p.name}
          >
            <span className="av-wrap">
              {isCurrent && inPlay && <TurnRing startedAt={state.turnStartedAt} />}
              <span className="av" style={{ background: col.bg, color: col.fg }}>
                {avatarLabel(p.name, names)}
              </span>
            </span>
            <span className="pscore-mini">
              {p.score}
              {p.id === me ? " · you" : p.left ? " · left" : ""}
            </span>
          </div>
        );
      })}
      <div className="strip-right">
        <span className="bag-count" title="Tiles left in the bag">
          {state.bagCount} left
        </span>
        <button className="icon-btn hist-btn" onClick={onHistory} aria-label="Move history">
          <Icon name="history" size={19} />
        </button>
      </div>
    </div>
  );
}

// ── Players scoreboard + move history (side panel on wide; drawer on mobile) ──
export function GameInfo({ state, me, showPlayers = true }: { state: PublicState; me: string; showPlayers?: boolean }) {
  const current = state.players[state.turnSeat];
  const names = state.players.map((p) => p.name);
  const ranked = [...state.players].sort((a, b) => b.score - a.score);
  return (
    <>
      {showPlayers && (
        <div className="gpanel">
          <p className="ph">
            <Icon name="trophy" size={15} /> Players
          </p>
          {ranked.map((p) => {
            const col = colorOf(p);
            const isCurrent = p.id === current?.id && state.phase !== "gameover";
            return (
              <div key={p.id} className={`prow${p.id === me ? " you" : ""}${p.left ? " gone" : ""}`}>
                <span className="av" style={{ background: col.bg, color: col.fg }}>
                  {avatarLabel(p.name, names)}
                </span>
                <span className="pn">
                  {p.name}
                  {p.id === me ? " · you" : ""}
                  {isCurrent ? " · turn" : ""}
                  {p.left ? " · left" : p.connected ? "" : " · away"}
                </span>
                <span className="ps">{p.score}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="gpanel">
        <p className="ph">
          <Icon name="history" size={15} /> Move history
        </p>
        {state.history.length === 0 ? (
          <p className="empty">No turns played yet.</p>
        ) : (
          [...state.history].reverse().map((rec, i) => (
            <div key={state.history.length - i} className="turn">
              <div className="tl">
                <span className="tname">{rec.name}</span>
                <span className="twhen">{whenLabel(i)}</span>
              </div>
              <div className="tw">
                {rec.words.map((w, j) => (
                  <span key={j} className="wchip">
                    <b>{displayLetter(w.word)}</b>
                    <span>+{w.points}</span>
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

export function ConfirmLeave({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="scrim" onClick={onCancel}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <p className="t">Leave the game?</p>
        <p className="s" style={{ marginTop: 4 }}>
          If you’re the host, the game ends for everyone.
        </p>
        <div className="confirm-btns">
          <button className="cta" onClick={onCancel}>
            No, stay
          </button>
          <button className="cta danger" onClick={onConfirm}>
            Yes, leave
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Turn-review popup (post-submit): open stage, then review/voting ──────────
export function TurnReview({
  state,
  me,
  onChallenge,
  onAccept,
  onVote,
}: {
  state: PublicState;
  me: string;
  onChallenge: (wordIndex: number) => void;
  onAccept: () => void;
  onVote: (vote: "allow" | "reject") => void;
}) {
  const pending = state.pending!;
  const submitter = state.players.find((p) => p.id === pending.submitterId);
  const isSubmitter = pending.submitterId === me;
  const formed = extractWords(state.board, pending.placed);
  const col = colorOf(submitter);
  const others = state.players.filter((p) => p.id !== pending.submitterId);

  const challengedIndices = new Set<number>();
  for (const list of Object.values(pending.challenges)) for (const i of list) challengedIndices.add(i);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const [defineWord, setDefineWord] = useState<string | null>(null);
  const defineModal = defineWord && (
    <DefineModal word={defineWord} room={state.code} onClose={() => setDefineWord(null)} />
  );

  // ── Review / voting stage ──────────────────────────────────────────────
  if (pending.stage === "review") {
    const challenger = state.players.find((p) => p.id === pending.challengerId);
    const challengedWords = [...challengedIndices].map((i) => pending.words[i]?.word).filter(Boolean);
    const wordsLabel = challengedWords.map((w) => `“${displayLetter(w)}”`).join(" / ");
    const myVote = pending.votes[me];
    const votedCount = others.filter((p) => pending.votes[p.id] !== undefined).length;

    return (
      <>
      <div className="scrim">
        <div className="modal">
          <div className="modal-head">
            <span className="avatar" style={{ background: colorOf(challenger).bg, color: colorOf(challenger).fg }}>
              <Icon name="flag" size={16} />
            </span>
            <div>
              <p className="t">Word under review</p>
              <p className="s">
                <b>{challenger?.name ?? "A player"}</b> challenged {wordsLabel || "a word"}
              </p>
            </div>
          </div>

          <div className="wordlist">
            {formed.map((w, i) =>
              challengedIndices.has(i) ? (
                <div key={i} className="wordcard challenged">
                  <div className="tiles">
                    {w.cells.map((cell, j) => (
                      <Tile key={j} letter={cell.letter} height={cell.height} />
                    ))}
                  </div>
                  <div className="wordrow">
                    <span className="pill">+{pending.words[i]?.points ?? 0}</span>
                    <div className="word-actions">
                      <button className="text-btn define" onClick={() => setDefineWord(w.word)}>
                        <Icon name="book" size={15} /> Define
                      </button>
                    </div>
                  </div>
                </div>
              ) : null,
            )}
          </div>

          <div className="divider" />

          {isSubmitter ? (
            <p className="muted" style={{ textAlign: "center" }}>
              Your word is under review — players are voting…
            </p>
          ) : (
            <div className="vote">
              <p className="vote-q">Is {wordsLabel || "the word"} a valid word?</p>
              <p className="vote-hint">
                Vote on the word itself — <b>Yes</b> if it’s a real word, <b>No</b> if it isn’t. This is not
                about whether the challenge was fair.
              </p>
              <div className="vote-btns">
                <button className={`vote-btn yes${myVote === "allow" ? " on" : ""}`} onClick={() => onVote("allow")}>
                  Yes — it’s valid
                </button>
                <button className={`vote-btn no${myVote === "reject" ? " on" : ""}`} onClick={() => onVote("reject")}>
                  No — not valid
                </button>
              </div>
            </div>
          )}

          <p className="muted" style={{ textAlign: "center", marginTop: 10 }}>
            {votedCount}/{others.length} voted · the word plays only if everyone allows it
          </p>
        </div>
      </div>
      {defineModal}
      </>
    );
  }

  // ── Open stage (accept / challenge with countdown) ──────────────────────
  const iAccepted = pending.stances[me] === "accepted";
  return (
    <>
    <div className="scrim">
      <div className="modal">
        <div className="modal-head">
          <span className="avatar" style={{ background: col.bg, color: col.fg }}>
            {avatarLabel(submitter?.name ?? "?", state.players.map((p) => p.name))}
          </span>
          <div>
            <p className="t">{isSubmitter ? "You submitted your turn" : `${submitter?.name} completed their turn`}</p>
            <p className="s">
              {formed.length} word{formed.length === 1 ? "" : "s"} · +{pending.totalPoints} points
            </p>
          </div>
        </div>

        <div className="wordlist">
          {formed.map((w, i) => {
            const pw = pending.words[i];
            const dup = pw?.duplicate;
            return (
              <div key={i} className={`wordcard${dup ? " duplicate" : ""}`}>
                <div className="tiles">
                  {w.cells.map((cell, j) => (
                    <Tile key={j} letter={cell.letter} height={cell.height} />
                  ))}
                </div>
                <div className="wordrow">
                  <span className="pill">+{pw?.points ?? 0}</span>
                  {dup ? (
                    // Already-played words score 0 and skip define/challenge.
                    <span className="repeat-badge">↻ played before{pw?.firstBy ? ` by ${pw.firstBy}` : ""}</span>
                  ) : (
                    <div className="word-actions">
                      <button className="text-btn define" onClick={() => setDefineWord(w.word)}>
                        <Icon name="book" size={15} /> Define
                      </button>
                      {!isSubmitter && (
                        <button className="text-btn challenge" onClick={() => onChallenge(i)}>
                          <Icon name="flag" size={15} /> Challenge
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="divider" />
        <div className="timerrow">
          <TimerRing seconds={pending.deadline ? (pending.deadline - now) / 1000 : 0} />
          <span>
            No challenge? Accepted automatically
            <br />
            when the timer runs out.
          </span>
        </div>

        {isSubmitter ? (
          <p className="muted" style={{ textAlign: "center" }}>
            Waiting for players to review…
          </p>
        ) : iAccepted ? (
          <p className="muted" style={{ textAlign: "center" }}>
            You accepted — waiting for others…
          </p>
        ) : (
          <button className="okay" onClick={onAccept}>
            <Icon name="check" size={18} /> Okay, looks good
          </button>
        )}
      </div>
    </div>
    {defineModal}
    </>
  );
}

// ── Definition modal (live Merriam-Webster lookup; informational only) ───────
function DefineModal({ word, room, onClose }: { word: string; room?: string; onClose: () => void }) {
  const [res, setRes] = useState<DefineResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setRes(null);
    fetchDefinition(word, room)
      .then((r) => alive && setRes(r))
      .catch(() => alive && setRes({ word, error: "Could not reach the dictionary." }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [word, room]);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="card define-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="avatar def">
            <Icon name="book" size={16} />
          </span>
          <div>
            <p className="t">{displayLetter(word)}</p>
            <p className="s">Merriam-Webster</p>
          </div>
          <button className="icon-btn def-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="define-body">
          {loading ? (
            <p className="muted">Looking up…</p>
          ) : res && "error" in res ? (
            <p className="muted">{res.error}</p>
          ) : res && res.found ? (
            res.entries.map((e, i) => (
              <div key={i} className="def-entry">
                {(e.fl || e.labels.length > 0) && (
                  <div className="def-tags">
                    {e.fl && <span className="def-fl">{e.fl}</span>}
                    {e.labels.map((l, k) => (
                      <span key={k} className="def-label">
                        {l}
                      </span>
                    ))}
                  </div>
                )}
                <ol className="def-list">
                  {e.defs.map((d, j) => (
                    <li key={j}>{d}</li>
                  ))}
                </ol>
              </div>
            ))
          ) : (
            <>
              <p className="muted">No dictionary entry found for “{displayLetter(word)}”.</p>
              {res && !res.found && res.suggestions?.length ? (
                <p className="muted small">Did you mean: {res.suggestions.join(", ")}?</p>
              ) : null}
            </>
          )}
        </div>

        <p className="muted small def-foot">Informational only — this doesn’t affect the vote.</p>
      </div>
    </div>
  );
}

// ── Reconnecting overlay (own socket dropped mid-session) ────────────────────
export function Reconnecting() {
  return (
    <div className="reconnect-scrim">
      <div className="reconnect-card">
        <span className="spinner" />
        Reconnecting…
      </div>
    </div>
  );
}

interface Superlative {
  icon: string;
  label: string;
  value: string;
  who?: string;
}

/** Fun end-of-game stats derived from the final board + move history (with the
 *  player responsible, where it can be attributed). */
function superlatives(state: PublicState): Superlative[] {
  const out: Superlative[] = [];
  const nameOf = (id?: string) => state.players.find((p) => p.id === id)?.name;

  // Tallest stack on the board (attributed to whoever placed its top tile).
  let tallest = 0;
  let tallestKey = "";
  for (let r = 0; r < state.board.length; r++)
    for (let c = 0; c < state.board[r].length; c++)
      if (state.board[r][c].length > tallest) {
        tallest = state.board[r][c].length;
        tallestKey = `${r},${c}`;
      }
  if (tallest >= 2) {
    const layers = state.boardMeta[tallestKey];
    out.push({ icon: "🗼", label: "Tallest stack", value: `${tallest} high`, who: nameOf(layers?.[layers.length - 1]?.by) });
  }

  // Best (highest-scoring) and longest words; best turn; best single-tile play.
  let best: { word: string; points: number; who?: string } | null = null;
  let longest: { word: string; who?: string } = { word: "" };
  let bestTurn: { total: number; who?: string } | null = null;
  let bestSolo: { total: number; who?: string } | null = null;
  for (const rec of state.history) {
    for (const w of rec.words) {
      if (!best || w.points > best.points) best = { word: w.word, points: w.points, who: rec.name };
      if (w.word.length > longest.word.length) longest = { word: w.word, who: rec.name };
    }
    if (!bestTurn || rec.total > bestTurn.total) bestTurn = { total: rec.total, who: rec.name };
    if (rec.tiles === 1 && (!bestSolo || rec.total > bestSolo.total))
      bestSolo = { total: rec.total, who: rec.name };
  }
  if (best && best.points > 0)
    out.push({ icon: "⭐", label: "Top word", value: `${displayLetter(best.word)} · +${best.points}`, who: best.who });
  if (longest.word.length >= 4 && longest.word.toLowerCase() !== best?.word.toLowerCase())
    out.push({ icon: "📏", label: "Longest word", value: displayLetter(longest.word), who: longest.who });
  if (bestTurn && bestTurn.total > 0)
    out.push({ icon: "🔥", label: "Best turn", value: `+${bestTurn.total}`, who: bestTurn.who });
  if (bestSolo && bestSolo.total > 0)
    out.push({ icon: "🎯", label: "Top 1-tile play", value: `+${bestSolo.total}`, who: bestSolo.who });
  return out;
}

/** "Xm Ys" / "Ys" for a game's elapsed wall-clock time. */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// ── End screen (game over / canceled) ───────────────────────────────────────
export function EndScreen({
  state,
  me,
  notice,
  onRematch,
  onRematchVote,
  onLeave,
}: {
  state: PublicState;
  me: string;
  notice?: string | null;
  onRematch: () => void;
  onRematchVote: (vote: "yes" | "no") => void;
  onLeave: () => void;
}) {
  const ranked = [...state.players].sort((a, b) => b.score - a.score);
  const topScore = ranked[0]?.score;
  const penaltyPts = DEFAULT_CONFIG.endgameTilePenaltyPoints;
  const iWon = state.players.find((p) => p.id === me)?.score === topScore;
  const canRematch = state.players.filter((p) => !p.left).length >= 2;
  const stats = superlatives(state);
  const medal = (i: number) => (i === 0 ? " 🏆" : i === 1 ? " 🥈" : "");
  const duration = state.gameStartedAt > 0 && state.gameEndedAt > 0 ? state.gameEndedAt - state.gameStartedAt : 0;

  // Win / lose sting on entry (only for a real, scored finish — not a cancel).
  useEffect(() => {
    if (!state.scored) return;
    const t = setTimeout(() => (iWon ? playWin() : playLose()), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Surface notices that arrive while on the end screen (e.g. rematch cancelled).
  const [toast, setToast] = useState<string | null>(null);
  const firstNotice = useRef(true);
  useEffect(() => {
    if (firstNotice.current) {
      firstNotice.current = false;
      return;
    }
    if (!notice) return;
    setToast(notice);
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  return (
    <div className="panel" style={{ textAlign: "center" }}>
      {toast && <div className="toast end-toast">{toast}</div>}
      <h2>Game over</h2>
      <p className="muted">{state.endReason ?? "The game has ended."}</p>
      <p className="muted small end-meta">
        Room {state.code}
        {duration > 0 ? ` · ${formatDuration(duration)}` : ""}
      </p>
      <ul className="players-list" style={{ textAlign: "left" }}>
        {ranked.map((p, i) => {
          // Show the leftover-tile penalty only when it was actually applied.
          const leftover = p.rack.length;
          const penalized = state.scored && leftover > 0;
          return (
            <li key={p.id}>
              <b>
                {p.name}
                {medal(i)}
              </b>
              <span style={{ marginLeft: "auto", textAlign: "right" }}>
                <span className="pscore-end">{p.score} pts</span>
                {penalized && (
                  <span className="muted penalty-note">
                    −{leftover * penaltyPts} · {leftover} tile{leftover === 1 ? "" : "s"} left
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {stats.length > 0 && (
        <div className="superlatives">
          {stats.map((s) => (
            <div key={s.label} className="superlative">
              <span className="sl-icon">{s.icon}</span>
              <span className="sl-label">{s.label}</span>
              <span className="sl-value">
                {s.value}
                {s.who ? <span className="sl-who"> · {s.who}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="end-actions">
        {canRematch && (
          <button className="cta primary" onClick={onRematch} disabled={state.phase === "rematch_pending"}>
            Rematch
          </button>
        )}
        <button className="cta" onClick={onLeave}>
          Back to home
        </button>
      </div>
      {state.phase === "rematch_pending" && state.rematch && (
        <RematchPopup state={state} me={me} onVote={onRematchVote} />
      )}
    </div>
  );
}

// ── Rematch vote popup (15s) ─────────────────────────────────────────────────
function RematchPopup({
  state,
  me,
  onVote,
}: {
  state: PublicState;
  me: string;
  onVote: (vote: "yes" | "no") => void;
}) {
  const rematch = state.rematch!;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(iv);
  }, []);
  const secs = Math.max(0, Math.ceil((rematch.deadline - now) / 1000));
  const byName = state.players.find((p) => p.id === rematch.by)?.name ?? "Someone";
  const yesCount = Object.values(rematch.votes).filter((v) => v === "yes").length;
  const isPrompter = me === rematch.by;
  const myVote = rematch.votes[me];

  return (
    <div className="scrim">
      <div className="modal rematch-pop" style={{ textAlign: "center" }}>
        {isPrompter ? (
          <>
            <h3>Rematch?</h3>
            <p className="muted">Waiting for the table… {secs}s</p>
            <p className="muted small">
              {yesCount} in so far{yesCount < 2 ? " — need one more" : ""}
            </p>
          </>
        ) : (
          <>
            <h3>{byName} wants a rematch</h3>
            <p className="muted">Join the next game? {secs}s</p>
            <div className="confirm-btns">
              <button
                className={`cta${myVote === "no" ? " danger" : ""}`}
                onClick={() => onVote("no")}
                disabled={myVote != null}
              >
                No
              </button>
              <button
                className={`cta${myVote === "yes" ? " primary" : ""}`}
                onClick={() => onVote("yes")}
                disabled={myVote != null}
              >
                {myVote === "yes" ? "You're in ✓" : "Yes"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Stack inspector (centered card; layers top → bottom) ─────────────────────
export function StackInspector({
  layers,
  players,
  onClose,
}: {
  layers: InspectLayer[];
  players: PlayerState[];
  onClose: () => void;
}) {
  const h = layers.length;
  const order = Array.from({ length: h }, (_, k) => h - 1 - k); // top → bottom
  return (
    <div className="scrim" onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div>
            <p className="t">{h > 1 ? `${h} tiles stacked here` : "Single tile"}</p>
            <p className="s">{h > 1 ? "Top to bottom — most recent first" : "Played once"}</p>
          </div>
          <button className="close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="layers">
          {order.map((idx) => {
            const ly = layers[idx];
            const isTop = idx === h - 1;
            const isBottom = idx === 0;
            const p = players.find((pl) => pl.id === ly.by);
            const col = colorOf(p);
            return (
              <div key={idx} className={`layer${isTop ? " current" : ""}`}>
                <div className="lt" style={{ background: ["#F6E9D2", "#EED9AE", "#E6C887", "#DDB75F", "#D2A23C"][Math.min(idx, 4)] }}>
                  {displayLetter(ly.letter)}
                </div>
                <div className="meta">
                  <div className="top">
                    Layer {idx + 1} · “{displayLetter(ly.letter)}”
                  </div>
                  <div className="by">
                    <span className="dot" style={{ background: col.bg, color: col.fg }}>
                      {initials(p?.name ?? "?")[0]}
                    </span>
                    {p?.name ?? "—"}
                    {(() => {
                      const ws = [ly.across, ly.down].filter(Boolean) as string[];
                      return ws.length ? ` · in ${ws.map(displayLetter).join(" / ")}` : "";
                    })()}
                  </div>
                </div>
                {isTop && h > 1 ? (
                  <span className="tag now">on top</span>
                ) : isBottom && h > 1 ? (
                  <span className="tag first">first</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Move history (bottom sheet; newest first) ────────────────────────────────
export function HistoryPanel({
  history,
  players,
  onClose,
}: {
  history: TurnRecord[];
  players: PlayerState[];
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const recs = [...history].reverse();
  const when = (i: number) => (i === 0 ? "just now" : `${i} turn${i > 1 ? "s" : ""} ago`);

  return (
    <div className="scrim bottom" onClick={onClose}>
      <div className={`sheet${open ? " open" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="grip" />
        <div className="sheet-head">
          <div>
            <p className="t">Move history</p>
            <p className="s">Newest first</p>
          </div>
          <button className="close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="turns">
          {recs.length === 0 ? (
            <p className="empty">No turns played yet.</p>
          ) : (
            recs.map((rec, i) => {
              const p = players.find((pl) => pl.id === rec.playerId);
              const col = colorOf(p);
              return (
                <div key={recs.length - i} className="turn">
                  <div className="avatar" style={{ background: col.bg, color: col.fg }}>
                    {avatarLabel(rec.name, players.map((pl) => pl.name))}
                  </div>
                  <div className="body">
                    <div className="line1">
                      <span className="name">{rec.name}</span>
                      <span className="when">{when(i)}</span>
                    </div>
                    <div className="words">
                      {rec.words.map((w, j) => (
                        <span key={j} className="wchip">
                          <b>{displayLetter(w.word)}</b>
                          <span className="pts">+{w.points}</span>
                        </span>
                      ))}
                    </div>
                    <div className="total">
                      {rec.words.length} word{rec.words.length > 1 ? "s" : ""} · +{rec.total} points
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
