import { useCallback, useEffect, useRef, useState } from "react";
import type { PlacedTile } from "../../worker/src/engine";
import type { ClientMessage, DefineResult, PublicState, ServerMessage } from "../../worker/src/protocol";
import {
  haptic,
  playAccepted,
  playBingo,
  playChallenge,
  playRejected,
  playScoreTally,
  playSubmit,
  playYourTurn,
} from "./sound";

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

export interface RoomInfo {
  exists: boolean;
  phase: "lobby" | "playing" | "pending" | "gameover" | null;
  isPlayer: boolean; // is the given playerId already in this room?
}

/** GET /room/:code/info → probe whether a room exists and whether I'm a player,
 *  so a shared link can auto-enter returning players without re-joining. */
export async function fetchRoomInfo(code: string, playerId: string): Promise<RoomInfo> {
  try {
    const res = await fetch(`/room/${encodeURIComponent(code)}/info?me=${encodeURIComponent(playerId)}`);
    if (!res.ok) return { exists: false, phase: null, isPlayer: false };
    return (await res.json()) as RoomInfo;
  } catch {
    return { exists: false, phase: null, isPlayer: false };
  }
}

/** GET /define → MW lookup. Passing the room code routes through that room's DO,
 *  which serves a short-TTL in-memory cache shared by everyone in the room. */
export async function fetchDefinition(word: string, room?: string): Promise<DefineResult> {
  const q = `?word=${encodeURIComponent(word)}${room ? `&room=${encodeURIComponent(room)}` : ""}`;
  const res = await fetch(`/define${q}`);
  return (await res.json()) as DefineResult;
}

/** A committed move, surfaced so the UI can animate a score pop / word flash. */
export interface AppliedEvent {
  by: string;
  points: number;
  bingo: boolean;
  at: number; // Date.now() — also acts as a change signal
}

export interface RoomConn {
  state: PublicState | null;
  connected: boolean;
  notice: string | null; // transient: errors, move applied/rejected
  applied: AppliedEvent | null; // last committed move (for animations)
  rejectSignal: number; // bumped on each move_rejected (for the tumble animation)
  me: string; // this client's playerId
  start: () => void;
  submit: (placed: PlacedTile[]) => void;
  placeDraft: (placed: PlacedTile[]) => void;
  challenge: (wordIndex: number) => void;
  acknowledge: () => void;
  vote: (vote: "allow" | "reject") => void;
  pass: () => void;
  swap: (index: number) => void;
  rematch: () => void;
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
  const [applied, setApplied] = useState<AppliedEvent | null>(null);
  const [rejectSignal, setRejectSignal] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const closedByUs = useRef(false);
  const prevCurrentId = useRef<string | undefined>(undefined);
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
          case "state": {
            // Detect the turn passing to me (it wasn't my turn before) → chime.
            const cur = msg.game.players[msg.game.turnSeat]?.id;
            if (msg.game.phase === "playing" && cur === me && prevCurrentId.current && prevCurrentId.current !== me) {
              playYourTurn();
              haptic(14);
            }
            if (msg.game.phase === "playing" || msg.game.phase === "pending") prevCurrentId.current = cur;
            else prevCurrentId.current = undefined;
            setState(msg.game);
            break;
          }
          case "move_pending":
            playSubmit(); // a player submitted their turn
            break;
          case "move_applied":
            setNotice(`Move accepted — +${msg.points} points`);
            if (msg.bingo) playBingo();
            else playAccepted(); // move committed (accepted / challenge allowed)
            playScoreTally(msg.points);
            haptic(msg.bingo ? [18, 40, 18] : 18);
            setApplied({ by: msg.by, points: msg.points, bingo: msg.bingo, at: Date.now() });
            break;
          case "move_rejected":
            setNotice(msg.reason);
            playRejected(); // move rejected by challenge
            haptic([10, 30, 10]);
            setRejectSignal((n) => n + 1);
            break;
          case "challenge_update":
            playChallenge(); // someone challenged a word — alert the table
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
    applied,
    rejectSignal,
    me,
    start: () => action({ type: "start_game" }),
    submit: (placed) => action({ type: "submit_move", placed }),
    placeDraft: (placed) => action({ type: "place_draft", placed }),
    challenge: (wordIndex) => action({ type: "challenge_word", wordIndex }),
    acknowledge: () => action({ type: "acknowledge_move" }),
    vote: (vote) => action({ type: "vote_move", vote }),
    pass: () => action({ type: "pass" }),
    swap: (index) => action({ type: "swap_tiles", index }),
    rematch: () => action({ type: "rematch" }),
    leave: () => action({ type: "leave" }),
  };
}
