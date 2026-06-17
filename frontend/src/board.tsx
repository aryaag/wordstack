import type { PointerEvent as ReactPointerEvent } from "react";
import type { Board as BoardT } from "../../worker/src/engine";
import type { PlayerState } from "../../worker/src/protocol";
import { AVATAR_COLORS, initials, Tile } from "./lib";

export type Overlay = Map<string, string>; // "r,c" → letter placed this turn (provisional)

export const cellKey = (r: number, c: number) => `${r},${c}`;

export function Board({
  board,
  overlay,
  hoverCell,
  onCell,
  onTilePointerDown,
  flash,
  tumble,
  shake = false,
  started = false,
}: {
  board: BoardT;
  overlay: Overlay;
  hoverCell?: string | null;
  onCell: (r: number, c: number) => void;
  /** Begin a drag from a provisional (staged) tile at this cell. */
  onTilePointerDown?: (key: string, e: ReactPointerEvent) => void;
  /** Cells to briefly flash gold (just committed). */
  flash?: Set<string>;
  /** Cells to render as tumbling tiles (a move was just rejected). */
  tumble?: Map<string, string> | null;
  /** Shake the whole board once (on rejection). */
  shake?: boolean;
  /** True once the first move has been played — fades the center markers. */
  started?: boolean;
}) {
  const cells = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const key = cellKey(r, c);
      const stack = board[r][c];
      const committedH = stack.length;
      const top = stack[committedH - 1];
      const ov = overlay.get(key);
      const isHover = hoverCell === key;
      if (ov) {
        cells.push(
          <Tile
            key={key}
            letter={ov}
            height={committedH + 1}
            isNew
            tappable
            draggable
            hover={isHover}
            dataCell={key}
            onClick={() => onCell(r, c)}
            onPointerDown={onTilePointerDown ? (e) => onTilePointerDown(key, e) : undefined}
          />,
        );
      } else if (top) {
        cells.push(
          <Tile
            key={key}
            letter={top}
            height={committedH}
            tappable
            hover={isHover}
            flash={flash?.has(key)}
            dataCell={key}
            onClick={() => onCell(r, c)}
          />,
        );
      } else if (tumble?.has(key)) {
        // A just-rejected tile, tumbling back off the board.
        cells.push(<Tile key={key} letter={tumble.get(key)!} isNew tumble />);
      } else {
        const isCenter = (r === 4 || r === 5) && (c === 4 || c === 5);
        cells.push(
          <div
            key={key}
            data-cell={key}
            className={`cell-empty target${isCenter ? " center" : ""}${isCenter && started ? " faded" : ""}${isHover ? " drop-hover" : ""}`}
            onClick={() => onCell(r, c)}
          />,
        );
      }
    }
  }
  return <div className={`board${shake ? " shake" : ""}`}>{cells}</div>;
}

export function Rail({ players, activeId }: { players: PlayerState[]; activeId?: string }) {
  return (
    <div className="rail">
      {players.map((p) => {
        const col = AVATAR_COLORS[p.seat % 4];
        return (
          <div key={p.id} className={`pchip${p.connected ? "" : " away"}`}>
            <div
              className={`avatar${p.id === activeId ? " active" : ""}`}
              style={{ background: col.bg, color: col.fg }}
            >
              {initials(p.name)}
            </div>
            <div className="pname">{p.name}</div>
            <div className="pscore">{p.score}</div>
          </div>
        );
      })}
    </div>
  );
}
