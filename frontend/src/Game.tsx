import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_CONFIG,
  extractWords,
  scoreTurn,
  validatePlacement,
  type PlacedTile,
} from "../../worker/src/engine";
import type { RoomConn } from "./useRoom";
import { haptic, playPlace, playRecall } from "./sound";
import { Board, cellKey, type Overlay } from "./board";
import { ConfirmLeave, GameInfo, HistoryPanel, PlayerStrip, RulesSheet, StackInspector, TurnReview, type InspectLayer } from "./overlays";
import { displayLetter, Icon, playedWords, Tile } from "./lib";

interface Staged {
  letter: string;
  rackIndex: number;
}

/** Where a drag started: a rack slot or an already-staged board cell. */
type DragSource = { kind: "rack"; rackIndex: number; slot: number } | { kind: "cell"; key: string };

/** Rack has RACK_SLOTS positions (tiles + a few empty ones for spacing); each
 *  slot holds a rack-tile index or null. Players can drag tiles between slots. */
const RACK_SLOTS = 10;

/** Re-map slot→rackIndex after the rack changes so the player's arrangement
 *  survives a turn: tiles still in the rack keep their slot, played tiles leave
 *  their slot empty, and newly drawn tiles fill the empty slots (left to right).
 *  Matched by letter as a multiset (handles duplicate letters). */
function reconcileSlots(
  prev: (number | null)[],
  oldRack: string[],
  newRack: string[],
): (number | null)[] {
  const pool = new Map<string, number[]>(); // letter → available new rack indices
  newRack.forEach((letter, i) => {
    const arr = pool.get(letter);
    if (arr) arr.push(i);
    else pool.set(letter, [i]);
  });
  const next: (number | null)[] = new Array(RACK_SLOTS).fill(null);
  // Keep each surviving tile where it already sits.
  for (let s = 0; s < RACK_SLOTS; s++) {
    const ri = prev[s];
    if (ri == null) continue;
    const avail = pool.get(oldRack[ri]);
    if (avail && avail.length) next[s] = avail.shift()!;
  }
  // Drop the freshly drawn tiles into the empty slots, in rack order.
  const leftover: number[] = [];
  for (const arr of pool.values()) leftover.push(...arr);
  leftover.sort((a, b) => a - b);
  let li = 0;
  for (let s = 0; s < RACK_SLOTS && li < leftover.length; s++) {
    if (next[s] == null) next[s] = leftover[li++];
  }
  return next;
}

interface DragGhost {
  letter: string;
  x: number;
  y: number;
}

export function Game({ room, onLeave }: { room: RoomConn; onLeave: () => void }) {
  const { state, me } = room;
  const [staged, setStaged] = useState<Map<string, Staged>>(new Map());
  const [selected, setSelected] = useState<number | null>(null);
  const [slots, setSlots] = useState<(number | null)[]>([]);
  const [inspect, setInspect] = useState<InspectLayer[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  // True only briefly after a rack refill, so the deal-in animation plays on a
  // fresh deal but NOT when the player drags tiles around their own rack.
  const [dealing, setDealing] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const [hoverCell, setHoverCell] = useState<string | null>(null);
  // Set true for one tick after a real drag so the trailing click is ignored.
  const suppressClick = useRef(false);

  // ── Juice: score pop, gold word flash, reject tumble/shake ──────────────
  const [scorePop, setScorePop] = useState<{ points: number; bingo: boolean; id: number } | null>(null);
  const [flashCells, setFlashCells] = useState<Set<string>>(new Set());
  const [tumble, setTumble] = useState<Map<string, string> | null>(null);
  const [boardShake, setBoardShake] = useState(false);
  const prevBoardRef = useRef<string[][][] | null>(null);
  const lastPendingRef = useRef<Map<string, string>>(new Map());
  const prevRackRef = useRef<string[]>([]);

  const myPlayer = state?.players.find((p) => p.id === me);
  const rackKey = myPlayer ? myPlayer.rack.join(",") : "";

  // Rack changed (a turn resolved): keep existing tiles in their slots and only
  // fill empty slots with the newly drawn tiles — don't reshuffle the rack.
  useEffect(() => {
    const newRack = myPlayer?.rack ?? [];
    setSlots((prev) => reconcileSlots(prev, prevRackRef.current, newRack));
    prevRackRef.current = newRack;
    setStaged(new Map());
    setSelected(null);
    setDealing(true);
    const t = setTimeout(() => setDealing(false), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackKey]);

  useEffect(() => {
    if (!room.notice) return;
    setToast(room.notice);
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [room.notice]);

  // A move committed → float a "+score" over the board.
  useEffect(() => {
    if (!room.applied) return;
    lastPendingRef.current = new Map(); // move resolved — don't tumble it on a later reject
    setScorePop({ points: room.applied.points, bingo: room.applied.bingo, id: room.applied.at });
    const t = setTimeout(() => setScorePop(null), 1400);
    return () => clearTimeout(t);
  }, [room.applied]);

  // Diff the committed board → briefly flash the cells whose stack just grew.
  const board = state?.board;
  useEffect(() => {
    if (!board) return;
    const prev = prevBoardRef.current;
    const changed = new Set<string>();
    if (prev) {
      for (let r = 0; r < board.length; r++)
        for (let c = 0; c < board[r].length; c++)
          if (board[r][c].length > (prev[r]?.[c]?.length ?? 0)) changed.add(cellKey(r, c));
    }
    prevBoardRef.current = board;
    if (!changed.size) return;
    setFlashCells(changed);
    const t = setTimeout(() => setFlashCells(new Set()), 800);
    return () => clearTimeout(t);
  }, [board]);

  // Remember the pending move's cells so we can tumble them if it's rejected.
  const pending = state?.pending;
  useEffect(() => {
    if (!pending) return;
    lastPendingRef.current = new Map(pending.placed.map((p) => [cellKey(p.row, p.col), p.letter]));
  }, [pending]);

  // A move was rejected → tumble the placed tiles off and shake the board. Also
  // return any still-staged tiles to the rack (e.g. an all-duplicate rejection
  // that never became a pending move).
  useEffect(() => {
    if (!room.rejectSignal) return;
    setStaged(new Map());
    setSelected(null);
    if (lastPendingRef.current.size) {
      setTumble(new Map(lastPendingRef.current));
      lastPendingRef.current = new Map(); // consumed — don't replay on the next reject
      const tt = setTimeout(() => setTumble(null), 600);
      const st = setTimeout(() => setBoardShake(false), 450);
      setBoardShake(true);
      return () => {
        clearTimeout(tt);
        clearTimeout(st);
      };
    }
  }, [room.rejectSignal]);

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
    setInspect(
      stack.map((letter, idx) => ({
        letter,
        by: meta[idx]?.by,
        across: meta[idx]?.across ?? meta[idx]?.word, // legacy layers stored a single `word`
        down: meta[idx]?.down,
      })),
    );
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
      playPlace(state.board[r][c].length + 1);
      haptic(10);
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
    const [r, c] = key.split(",").map(Number);
    playPlace(state.board[r][c].length + 1);
    haptic(10);
    setSelected(null);
  };

  // Dropping a staged tile back over the rack (but not a specific slot) recalls it.
  const dropOnRack = (source: DragSource) => {
    if (source.kind !== "cell") return;
    const m = new Map(staged);
    m.delete(source.key);
    stageTiles(m);
    playRecall();
    haptic(10);
    setSelected(null);
  };

  // Drop a tile onto a rack slot: rearrange within the rack (swapping with any
  // occupant), and if the tile came from the board, recall it at the same time.
  const dropOnSlot = (source: DragSource, toSlot: number) => {
    const rackIndex = source.kind === "rack" ? source.rackIndex : staged.get(source.key)!.rackIndex;
    const fromSlot = slots.indexOf(rackIndex);
    if (source.kind === "rack" && fromSlot === toSlot) return; // dropped on itself
    const ns = [...slots];
    const occupant = ns[toSlot];
    if (fromSlot >= 0) ns[fromSlot] = occupant; // occupant (or null) takes the old slot
    ns[toSlot] = rackIndex;
    setSlots(ns);
    if (source.kind === "cell") {
      const m = new Map(staged);
      m.delete(source.key);
      stageTiles(m);
    }
    playRecall(); // local-only feedback (rearrange or recall) — never broadcast
    haptic(10);
    setSelected(null);
  };

  // Pointer-based drag (works for touch + mouse). A press that never moves past
  // the threshold is left alone so the existing tap handlers still fire.
  const beginDrag = (source: DragSource, letter: string, e: ReactPointerEvent) => {
    // Off-turn you can still rearrange your own rack (rack-source drags only);
    // board placement stays gated to your turn (enforced in onUp below).
    if (!isMyTurn && source.kind !== "rack") return;
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
      const slotAttr = el?.closest("[data-rack-slot]")?.getAttribute("data-rack-slot");
      if (cell) {
        if (isMyTurn) dropOnCell(source, letter, cell); // off-turn: can't place on the board
      } else if (slotAttr != null) dropOnSlot(source, Number(slotAttr));
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
    haptic(22);
    room.submit(placed);
    setStaged(new Map());
    setSelected(null);
  };
  const swap = () => {
    if (selected === null) return;
    room.swap(selected);
    setSelected(null);
  };

  return (
    <>
      <div className="appbar">
        <span className="brand">
          <span className="mini">W</span> WordStack
        </span>
        <span className="right">
          <span className="room">{state.code}</span>
          <button className="icon-btn" onClick={() => setRulesOpen(true)} aria-label="How to play">
            <Icon name="scroll" size={19} />
          </button>
          {me === state.hostId && state.canUndo && phase === "playing" && (
            <button className="icon-btn" onClick={() => room.undo()} aria-label="Undo last move">
              <Icon name="undo" size={19} />
            </button>
          )}
          <button className="icon-btn" onClick={() => setConfirmLeave(true)} aria-label="Leave">
            <Icon name="leave" size={19} />
          </button>
        </span>
      </div>

      <PlayerStrip state={state} me={me} onHistory={() => setHistoryOpen(true)} />

      <div className="game-body">
        <div className="game-main">
          <div className="board-wrap">
            <Board
              board={state.board}
              overlay={overlay}
              started={state.history.length > 0}
              hoverCell={hoverCell}
              onCell={onCell}
              onTilePointerDown={
                isMyTurn ? (key, e) => beginDrag({ kind: "cell", key }, overlay.get(key)!, e) : undefined
              }
              flash={flashCells}
              tumble={tumble}
              shake={boardShake}
            />
            {scorePop && (
              <div key={scorePop.id} className={`score-pop${scorePop.bingo ? " bingo" : ""}`}>
                {scorePop.bingo && <span className="bingo-label">BINGO!</span>}+{scorePop.points}
              </div>
            )}
          </div>

          {isMyTurn && (
            <div className={`preview${preview?.bad ? " bad" : ""}`}>
              {preview?.text}
              {preview?.note && <span className="preview-note">{preview.note}</span>}
            </div>
          )}

          <div className={`tray${isMyTurn ? " active" : ""}`}>
            <div className="tray-turn">
              {isMyTurn ? "Your turn" : `${current?.name ?? "—"}'s turn`}
              {!isMyTurn && current && !current.connected && phase === "playing" && " · reconnecting…"}
            </div>
            <div className="rack" data-rack>
              {slots.map((ri, slotIdx) => {
                // Guard against a stale `slots` entry pointing past a shrunken rack
                // (happens for one render after the bag empties) — render it empty.
                const letter = ri == null ? undefined : myRack[ri];
                return letter == null || ri == null ? (
                  <div key={slotIdx} className="rack-slot empty" data-rack-slot={slotIdx} />
                ) : (
                  <div
                    key={slotIdx}
                    className={`rack-slot${dealing ? " deal-in" : ""}`}
                    data-rack-slot={slotIdx}
                    style={dealing ? { animationDelay: `${slotIdx * 35}ms` } : undefined}
                  >
                    <Tile
                      letter={letter}
                      selected={ri === selected}
                      dim={used.has(ri)}
                      tappable={isMyTurn}
                      draggable={!used.has(ri)}
                      onClick={isMyTurn ? () => onRackTap(ri) : undefined}
                      onPointerDown={
                        !used.has(ri)
                          ? (e) => beginDrag({ kind: "rack", rackIndex: ri, slot: slotIdx }, letter, e)
                          : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
            {isMyTurn && (
              <div className="actions">
                <button
                  className="round-btn"
                  onClick={() => room.pass()}
                  disabled={staged.size > 0}
                  aria-label="Skip turn"
                >
                  <Icon name="ban" size={18} />
                </button>
                <button
                  className="round-btn"
                  onClick={swap}
                  disabled={staged.size > 0 || selected === null || state.bagCount === 0}
                  aria-label="Swap selected tile"
                >
                  <Icon name="swap" size={18} />
                </button>
                <button className="round-btn commit" onClick={commit} disabled={!valid} aria-label="Submit">
                  <Icon name="check" size={22} />
                </button>
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
      {historyOpen && (
        <HistoryPanel history={state.history} players={state.players} onClose={() => setHistoryOpen(false)} />
      )}
      {rulesOpen && <RulesSheet onClose={() => setRulesOpen(false)} />}
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
