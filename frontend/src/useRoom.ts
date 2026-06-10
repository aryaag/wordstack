import { useCallback, useEffect, useRef, useState } from "react";
import type { PlacedTile } from "../../worker/src/engine";
import type { ClientMessage, PublicState, ServerMessage } from "../../worker/src/protocol";

const PLAYER_ID_KEY = "upwords:playerId";
const NAME_KEY = "upwords:name";

export function getPlayerId(): string {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

export function getStoredName(): string {
  return localStorage.getItem(NAME_KEY) ?? "";
}
export function setStoredName(name: string): void {
  localStorage.setItem(NAME_KEY, name);
}

/** POST /room → new room code. */
export async function createRoom(): Promise<string> {
  const res = await fetch("/room", { method: "POST" });
  if (!res.ok) throw new Error(`could not create room (${res.status})`);
  return (await res.json()).code as string;
}

export interface RoomConn {
  state: PublicState | null;
  connected: boolean;
  notice: string | null; // transient: errors, move applied/rejected
  me: string; // this client's playerId
  start: () => void;
  submit: (placed: PlacedTile[]) => void;
  placeDraft: (placed: PlacedTile[]) => void;
  challenge: (wordIndex: number) => void;
  acknowledge: () => void;
  vote: (vote: "allow" | "reject") => void;
  pass: () => void;
  swap: (index: number) => void;
  leave: () => void;
}

function wsUrl(code: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/room/${code}/ws`;
}

/** Connects to a room over WebSocket, joins, and keeps the live state in sync. */
export function useRoom(code: string | null, name: string): RoomConn {
  const [state, setState] = useState<PublicState | null>(null);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const closedByUs = useRef(false);
  const me = getPlayerId();

  useEffect(() => {
    if (!code) return;
    closedByUs.current = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const send = (msg: ClientMessage) => wsRef.current?.send(JSON.stringify(msg));

    const connect = () => {
      const ws = new WebSocket(wsUrl(code));
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        retry = 0;
        setConnected(true);
        send({ type: "join", playerId: me, name });
      });

      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        switch (msg.type) {
          case "state":
            setState(msg.game);
            break;
          case "move_applied":
            setNotice(`Move accepted — +${msg.points} points`);
            break;
          case "move_rejected":
            setNotice(msg.reason);
            break;
          case "challenge_result":
            setNotice(msg.challenged.map((c) => `"${c.word}" was challenged`).join(", "));
            break;
          case "game_over":
            setNotice(msg.reason);
            break;
          case "error":
            setNotice(msg.message);
            break;
        }
      });

      ws.addEventListener("close", () => {
        setConnected(false);
        if (closedByUs.current) return;
        retry++;
        timer = setTimeout(connect, Math.min(1000 * retry, 5000)); // reconnect → re-join same seat
      });

      ws.addEventListener("error", () => ws.close());
    };

    connect();
    return () => {
      closedByUs.current = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [code, me, name]);

  const action = useCallback((msg: ClientMessage) => wsRef.current?.send(JSON.stringify(msg)), []);

  return {
    state,
    connected,
    notice,
    me,
    start: () => action({ type: "start_game" }),
    submit: (placed) => action({ type: "submit_move", placed }),
    placeDraft: (placed) => action({ type: "place_draft", placed }),
    challenge: (wordIndex) => action({ type: "challenge_word", wordIndex }),
    acknowledge: () => action({ type: "acknowledge_move" }),
    vote: (vote) => action({ type: "vote_move", vote }),
    pass: () => action({ type: "pass" }),
    swap: (index) => action({ type: "swap_tiles", index }),
    leave: () => action({ type: "leave" }),
  };
}
