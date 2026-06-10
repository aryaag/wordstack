import { useEffect, useState } from "react";
import { extractWords } from "../../worker/src/engine";
import type { PlayerState, PublicState, TurnRecord } from "../../worker/src/protocol";
import { AVATAR_COLORS, displayLetter, Icon, initials, Tile, TimerRing } from "./lib";

const FALLBACK = { bg: "#D3D1C7", fg: "#444" };
const colorOf = (p?: PlayerState) => (p ? AVATAR_COLORS[p.seat % 4] : FALLBACK);

export interface InspectLayer {
  letter: string;
  by?: string;
  word?: string;
}

// ── Turn-review popup (post-submit) ──────────────────────────────────────────
export function TurnReview({
  state,
  me,
  onChallenge,
  onAccept,
}: {
  state: PublicState;
  me: string;
  onChallenge: (wordIndex: number) => void;
  onAccept: () => void;
}) {
  const pending = state.pending!;
  const submitter = state.players.find((p) => p.id === pending.submitterId);
  const isSubmitter = pending.submitterId === me;
  const formed = extractWords(state.board, pending.placed);
  const col = colorOf(submitter);

  const challengedIndices = new Set<number>();
  for (const list of Object.values(pending.challenges)) for (const i of list) challengedIndices.add(i);
  const iChallenged = new Set(pending.challenges[me] ?? []);
  const iAccepted = pending.stances[me] === "accepted";

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="scrim">
      <div className="modal">
        <div className="modal-head">
          <span className="avatar" style={{ background: col.bg, color: col.fg }}>
            {initials(submitter?.name ?? "?")}
          </span>
          <div>
            <p className="t">{isSubmitter ? "You submitted your turn" : `${submitter?.name} completed their turn`}</p>
            <p className="s">
              {formed.length} word{formed.length === 1 ? "" : "s"} · +{pending.totalPoints} points
            </p>
          </div>
        </div>

        <div className="wordlist">
          {formed.map((w, i) => (
            <div key={i} className={`wordcard${challengedIndices.has(i) ? " challenged" : ""}`}>
              <div className="tiles">
                {w.cells.map((cell, j) => (
                  <Tile key={j} letter={cell.letter} height={cell.height} />
                ))}
              </div>
              <div className="wordrow">
                <span className="pill">+{pending.words[i]?.points ?? 0}</span>
                <div className="word-actions">
                  <button className="text-btn define" disabled title="Definitions arrive in Phase 6">
                    <Icon name="book" size={15} /> Define
                  </button>
                  {!isSubmitter && (
                    <button
                      className={`text-btn challenge${iChallenged.has(i) ? " challenged" : ""}`}
                      disabled={iChallenged.has(i)}
                      onClick={() => onChallenge(i)}
                    >
                      <Icon name="flag" size={15} /> {iChallenged.has(i) ? "Challenged" : "Challenge"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="divider" />
        <div className="timerrow">
          <TimerRing seconds={(pending.deadline - now) / 1000} />
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
                    {ly.word ? ` · in ${displayLetter(ly.word)}` : ""}
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
                    {initials(rec.name)}
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
