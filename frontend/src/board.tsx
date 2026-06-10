import type { Board as BoardT } from "../../worker/src/engine";
import type { PlayerState } from "../../worker/src/protocol";
import { AVATAR_COLORS, initials, Tile } from "./lib";

export type Overlay = Map<string, string>; // "r,c" → letter placed this turn (provisional)

export const cellKey = (r: number, c: number) => `${r},${c}`;

export function Board({
  board,
  overlay,
  onCell,
}: {
  board: BoardT;
  overlay: Overlay;
  onCell: (r: number, c: number) => void;
}) {
  const cells = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const key = cellKey(r, c);
      const stack = board[r][c];
      const committedH = stack.length;
      const top = stack[committedH - 1];
      const ov = overlay.get(key);
      if (ov) {
        cells.push(<Tile key={key} letter={ov} height={committedH + 1} isNew tappable onClick={() => onCell(r, c)} />);
      } else if (top) {
        cells.push(<Tile key={key} letter={top} height={committedH} tappable onClick={() => onCell(r, c)} />);
      } else {
        cells.push(<div key={key} className="cell-empty target" onClick={() => onCell(r, c)} />);
      }
    }
  }
  return <div className="board">{cells}</div>;
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
