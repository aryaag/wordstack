import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_CONFIG,
  extractWords,
  scoreTurn,
  validatePlacement,
  type PlacedTile,
} from "../../worker/src/engine";
import type { RoomConn } from "./useRoom";
import { playPlace } from "./sound";
import { Board, cellKey, type Overlay } from "./board";
import { ConfirmLeave, GameInfo, PlayerStrip, StackInspector, TurnReview, type InspectLayer } from "./overlays";
import { AVATAR_COLORS, displayLetter, Icon, initials, playedWords, Tile } from "./lib";

interface Staged {
  letter: string;
  rackIndex: number;
}

/** Where a drag started: a rack slot or an already-staged board cell. */
type DragSource = { kind: "rack"; rackIndex: number } | { kind: "cell"; key: string };

interface DragGhost {
  letter: string;
  x: number;
  y: number;
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
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const [hoverCell, setHoverCell] = useState<string | null>(null);
  // Set true for one tick after a real drag so the trailing click is ignored.
  const suppressClick = useRef(false);

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

  // Announce the (randomly chosen) starting player once, when the game begins.
  const announcedStart = useRef(false);
  useEffect(() => {
    if (!state) return;
    if (state.phase === "lobby") {
      announcedStart.current = false; // reset so a rematch re-announces
      return;
    }
    if (state.phase !== "playing" || state.history.length > 0 || announcedStart.current) return;
    announcedStart.current = true;
    const starter = state.players[state.turnSeat];
    if (!starter) return;
    setToast(`🎲 ${starter.id === me ? "You go" : `${starter.name} goes`} first`);
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [state, me]);

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
    if (suppressClick.current) return;
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
      playPlace();
      setSelected(null);
    } else {
      openInspect(r, c);
    }
  };

  const onRackTap = (i: number) => {
    if (suppressClick.current) return;
    if (used.has(i)) return;
    setSelected(selected === i ? null : i);
  };

  // Move a staged tile onto a target cell, or stage a rack tile there.
  // A target already holding a different staged tile is left untouched.
  const dropOnCell = (source: DragSource, letter: string, key: string) => {
    const m = new Map(staged);
    if (source.kind === "cell") {
      if (source.key === key) return;
      m.delete(source.key);
    }
    const occupant = m.get(key);
    if (occupant) return; // a staged tile already lives here — don't clobber it
    const rackIndex = source.kind === "rack" ? source.rackIndex : staged.get(source.key)!.rackIndex;
    m.set(key, { letter, rackIndex });
    stageTiles(m);
    playPlace();
    setSelected(null);
  };

  // Dropping a staged tile back over the rack recalls it.
  const dropOnRack = (source: DragSource) => {
    if (source.kind !== "cell") return;
    const m = new Map(staged);
    m.delete(source.key);
    stageTiles(m);
    setSelected(null);
  };

  // Pointer-based drag (works for touch + mouse). A press that never moves past
  // the threshold is left alone so the existing tap handlers still fire.
  const beginDrag = (source: DragSource, letter: string, e: ReactPointerEvent) => {
    if (!isMyTurn) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;

    const cellAt = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest("[data-cell]")?.getAttribute("data-cell") ?? null;

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      moved = true;
      setGhost({ letter, x: ev.clientX, y: ev.clientY });
      setHoverCell(cellAt(ev.clientX, ev.clientY));
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setGhost(null);
      setHoverCell(null);
      if (!moved) return; // treat as a tap
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const cell = el?.closest("[data-cell]")?.getAttribute("data-cell");
      if (cell) dropOnCell(source, letter, cell);
      else if (el?.closest("[data-rack]")) dropOnRack(source);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const placed: PlacedTile[] = mapToPlaced(staged);
  const validation = staged.size ? validatePlacement(state.board, placed, myRack, DEFAULT_CONFIG) : null;
  const valid = validation?.ok ?? false;
  let preview: { text: string; bad: boolean; note?: string } | null = null;
  if (staged.size && validation) {
    if (validation.ok) {
      const words = extractWords(state.board, placed);
      const score = scoreTurn(words, placed, DEFAULT_CONFIG);
      const played = playedWords(state.history);
      const repeats = [...new Set(words.map((w) => w.word).filter((w) => played.has(w)))];
      preview = {
        text: `${staged.size} new · ${words.map((w) => displayLetter(w.word)).join(" + ")} · +${score.total} pts`,
        bad: false,
        note: repeats.length
          ? `↻ ${repeats.map(displayLetter).join(", ")} already played this game`
          : undefined,
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
          <span className="mini">W</span> Wordstack
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
          <Board
            board={state.board}
            overlay={overlay}
            hoverCell={hoverCell}
            onCell={onCell}
            onTilePointerDown={isMyTurn ? (key, e) => beginDrag({ kind: "cell", key }, overlay.get(key)!, e) : undefined}
          />

          <div className={`banner${isMyTurn ? "" : " muted-banner"}`}>
            <span className="who">
              <span
                className="avatar"
                style={{ width: 26, height: 26, fontSize: 11, background: curCol.bg, color: curCol.fg }}
              >
                {initials(current?.name ?? "?")}
              </span>
              {isMyTurn ? "Your turn" : `${current?.name ?? "—"}'s turn`}
              {current && !current.connected && phase === "playing" && (
                <span className="away-hint"> · reconnecting, auto-skip soon</span>
              )}
            </span>
            <span>{state.bagCount} tiles left</span>
          </div>

          {isMyTurn && (
            <div className={`preview${preview?.bad ? " bad" : ""}`}>
              {preview?.text}
              {preview?.note && <span className="preview-note">{preview.note}</span>}
            </div>
          )}

          <div className="tray">
            <div className="rack" data-rack>
              {order.map((i) => (
                <Tile
                  key={i}
                  letter={myRack[i]}
                  selected={i === selected}
                  dim={used.has(i)}
                  tappable={isMyTurn}
                  draggable={isMyTurn && !used.has(i)}
                  onClick={isMyTurn ? () => onRackTap(i) : undefined}
                  onPointerDown={
                    isMyTurn && !used.has(i)
                      ? (e) => beginDrag({ kind: "rack", rackIndex: i }, myRack[i], e)
                      : undefined
                  }
                />
              ))}
            </div>
            {isMyTurn && (
              <div className="actions">
                {staged.size > 0 ? (
                  <>
                    <div className="act">
                      <button className="round-btn" onClick={recall} aria-label="Recall tiles">
                        <Icon name="undo" size={18} />
                      </button>
                      <span className="act-label">recall</span>
                    </div>
                    <div className="act">
                      <button className="round-btn" onClick={shuffle} aria-label="Shuffle rack">
                        <Icon name="shuffle" size={18} />
                      </button>
                      <span className="act-label">shuffle</span>
                    </div>
                    <div className="act">
                      <button className="round-btn commit" onClick={commit} disabled={!valid} aria-label="Submit">
                        <Icon name="check" size={22} />
                      </button>
                      <span className="act-label">submit</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="act">
                      <button className="round-btn" onClick={() => room.pass()} aria-label="Pass">
                        <Icon name="ban" size={18} />
                      </button>
                      <span className="act-label">pass</span>
                    </div>
                    <div className="act">
                      <button
                        className="round-btn"
                        onClick={swap}
                        disabled={selected === null || state.bagCount === 0}
                        aria-label="Swap selected tile"
                      >
                        <Icon name="swap" size={18} />
                      </button>
                      <span className="act-label">swap</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <aside className="game-side">
          <GameInfo state={state} me={me} showPlayers={false} />
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
      {ghost && (
        <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <Tile letter={ghost.letter} isNew />
        </div>
      )}
    </>
  );
}
