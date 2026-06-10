import { useEffect, useState } from "react";
import {
  DEFAULT_CONFIG,
  extractWords,
  scoreTurn,
  validatePlacement,
  type PlacedTile,
} from "../../worker/src/engine";
import type { RoomConn } from "./useRoom";
import { Board, cellKey, type Overlay } from "./board";
import { ConfirmLeave, GameInfo, PlayerStrip, StackInspector, TurnReview, type InspectLayer } from "./overlays";
import { AVATAR_COLORS, displayLetter, Icon, initials, Tile } from "./lib";

interface Staged {
  letter: string;
  rackIndex: number;
}

export function Game({ room, onLeave }: { room: RoomConn; onLeave: () => void }) {
  const { state, me } = room;
  const [staged, setStaged] = useState<Map<string, Staged>>(new Map());
  const [selected, setSelected] = useState<number | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [inspect, setInspect] = useState<InspectLayer[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const myPlayer = state?.players.find((p) => p.id === me);
  const rackKey = myPlayer ? myPlayer.rack.join(",") : "";

  useEffect(() => {
    setOrder(myPlayer ? myPlayer.rack.map((_, i) => i) : []);
    setStaged(new Map());
    setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackKey]);

  useEffect(() => {
    if (!room.notice) return;
    setToast(room.notice);
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [room.notice]);

  if (!state || !myPlayer) return null;

  const phase = state.phase;
  const current = state.players[state.turnSeat];
  const isMyTurn = current?.id === me && phase === "playing";
  const myRack = myPlayer.rack;
  const used = new Set([...staged.values()].map((s) => s.rackIndex));

  const overlay: Overlay = new Map();
  if (phase === "pending" && state.pending) {
    for (const p of state.pending.placed) overlay.set(cellKey(p.row, p.col), p.letter);
  } else if (isMyTurn) {
    for (const [k, v] of staged) overlay.set(k, v.letter);
  } else if (phase === "playing" && state.draft && state.draft.by === current?.id) {
    // Watch the current player's tiles appear live, before they submit.
    for (const p of state.draft.placed) overlay.set(cellKey(p.row, p.col), p.letter);
  }

  const openInspect = (r: number, c: number) => {
    const stack = state.board[r][c];
    if (!stack.length) return;
    const meta = state.boardMeta[cellKey(r, c)] ?? [];
    setInspect(stack.map((letter, idx) => ({ letter, by: meta[idx]?.by, word: meta[idx]?.word })));
  };

  const mapToPlaced = (m: Map<string, Staged>): PlacedTile[] =>
    [...m.entries()].map(([key, v]) => {
      const [r, c] = key.split(",").map(Number);
      return { row: r, col: c, letter: v.letter };
    });
  // Update staged tiles AND broadcast them live so everyone sees the placement.
  const stageTiles = (m: Map<string, Staged>) => {
    setStaged(m);
    room.placeDraft(mapToPlaced(m));
  };

  const onCell = (r: number, c: number) => {
    if (!isMyTurn) return openInspect(r, c);
    const key = cellKey(r, c);
    if (staged.has(key)) {
      const m = new Map(staged);
      m.delete(key);
      stageTiles(m);
      setSelected(null);
    } else if (selected !== null) {
      const m = new Map(staged);
      m.set(key, { letter: myRack[selected], rackIndex: selected });
      stageTiles(m);
      setSelected(null);
    } else {
      openInspect(r, c);
    }
  };

  const onRackTap = (i: number) => {
    if (used.has(i)) return;
    setSelected(selected === i ? null : i);
  };

  const placed: PlacedTile[] = mapToPlaced(staged);
  const validation = staged.size ? validatePlacement(state.board, placed, myRack, DEFAULT_CONFIG) : null;
  const valid = validation?.ok ?? false;
  let preview: { text: string; bad: boolean } | null = null;
  if (staged.size && validation) {
    if (validation.ok) {
      const words = extractWords(state.board, placed);
      const score = scoreTurn(words, placed, DEFAULT_CONFIG);
      preview = {
        text: `${staged.size} new · ${words.map((w) => displayLetter(w.word)).join(" + ")} · +${score.total} pts`,
        bad: false,
      };
    } else {
      preview = { text: validation.reason, bad: true };
    }
  }

  const commit = () => {
    if (!valid) return;
    room.submit(placed);
    setStaged(new Map());
    setSelected(null);
  };
  const recall = () => {
    stageTiles(new Map());
    setSelected(null);
  };
  const shuffle = () => setOrder((o) => [...o].sort(() => Math.random() - 0.5));
  const swap = () => {
    if (selected === null) return;
    room.swap(selected);
    setSelected(null);
  };

  const curCol = AVATAR_COLORS[(current?.seat ?? 0) % 4];

  return (
    <>
      <div className="appbar">
        <span className="brand">
          <span className="mini">U</span> Upwords
        </span>
        <span className="right">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label="Players & history">
            <Icon name="menu" size={20} />
          </button>
          <span className="room">{state.code}</span>
          <button className="icon-btn" onClick={() => setConfirmLeave(true)} aria-label="Leave">
            <Icon name="leave" size={19} />
          </button>
        </span>
      </div>

      <PlayerStrip state={state} me={me} />

      <div className="game-body">
        <div className="game-main">
          <Board board={state.board} overlay={overlay} onCell={onCell} />

          <div className={`banner${isMyTurn ? "" : " muted-banner"}`}>
            <span className="who">
              <span
                className="avatar"
                style={{ width: 26, height: 26, fontSize: 11, background: curCol.bg, color: curCol.fg }}
              >
                {initials(current?.name ?? "?")}
              </span>
              {isMyTurn ? "Your turn" : `${current?.name ?? "—"}'s turn`}
            </span>
            <span>{state.bagCount} tiles left</span>
          </div>

          {isMyTurn && <div className={`preview${preview?.bad ? " bad" : ""}`}>{preview?.text}</div>}

          <div className="tray">
            <div className="rack">
              {order.map((i) => (
                <Tile
                  key={i}
                  letter={myRack[i]}
                  selected={i === selected}
                  dim={used.has(i)}
                  tappable={isMyTurn}
                  onClick={isMyTurn ? () => onRackTap(i) : undefined}
                />
              ))}
            </div>
            {isMyTurn && (
              <div className="actions">
                {staged.size > 0 ? (
                  <>
                    <button className="round-btn" onClick={recall} aria-label="Recall tiles">
                      <Icon name="undo" size={18} />
                    </button>
                    <button className="round-btn" onClick={shuffle} aria-label="Shuffle rack">
                      <Icon name="shuffle" size={18} />
                    </button>
                    <button className="round-btn commit" onClick={commit} disabled={!valid} aria-label="Complete turn">
                      <Icon name="check" size={22} />
                    </button>
                  </>
                ) : (
                  <>
                    <button className="round-btn" onClick={() => room.pass()} aria-label="Pass">
                      <Icon name="pass" size={18} />
                    </button>
                    <button
                      className="round-btn"
                      onClick={swap}
                      disabled={selected === null || state.bagCount === 0}
                      aria-label="Swap selected tile"
                    >
                      <Icon name="swap" size={18} />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <aside className="game-side">
          <GameInfo state={state} me={me} />
        </aside>
      </div>

      {phase === "pending" && state.pending && (
        <TurnReview
          state={state}
          me={me}
          onChallenge={room.challenge}
          onAccept={room.acknowledge}
          onVote={room.vote}
        />
      )}
      {inspect && <StackInspector layers={inspect} players={state.players} onClose={() => setInspect(null)} />}
      {menuOpen && (
        <div className="scrim bottom" onClick={() => setMenuOpen(false)}>
          <div className="sheet open" onClick={(e) => e.stopPropagation()}>
            <div className="grip" />
            <div className="menu-body">
              <GameInfo state={state} me={me} />
            </div>
          </div>
        </div>
      )}
      {confirmLeave && (
        <ConfirmLeave
          onCancel={() => setConfirmLeave(false)}
          onConfirm={() => {
            room.leave();
            onLeave();
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
