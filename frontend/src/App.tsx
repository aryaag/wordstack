import { useEffect, useState } from "react";
import { createRoom, fetchRoomInfo, getPlayerId, getStoredName, setStoredName, useRoom } from "./useRoom";
import { Landing, Lobby } from "./Landing";
import { Game } from "./Game";
import { EndScreen, Reconnecting } from "./overlays";
import "./App.css";

const roomFromUrl = () => new URLSearchParams(location.search).get("room");
function setRoomUrl(code: string | null) {
  const url = new URL(location.href);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  history.replaceState({}, "", url);
}

export function App() {
  // `joined` = the room the player has committed to (drives the room view).
  const [joined, setJoined] = useState<string | null>(null);
  const [name, setName] = useState(getStoredName());
  const [roomParam, setRoomParam] = useState<string | null>(roomFromUrl());
  const [probing, setProbing] = useState<boolean>(!!roomParam);

  // Landing on a shared link: if I'm ALREADY a player in this room, enter directly
  // (reconnect to a game/lobby in progress). Otherwise fall through to the join
  // screen with the code pre-filled. (No spectator mode — non-players just see the
  // landing; joining an in-progress game is rejected server-side as before.)
  useEffect(() => {
    if (joined || !roomParam) {
      setProbing(false);
      return;
    }
    let alive = true;
    setProbing(true);
    fetchRoomInfo(roomParam, getPlayerId())
      .then((info) => {
        if (!alive) return;
        if (info.exists && info.isPlayer) {
          setRoomUrl(roomParam);
          setJoined(roomParam);
        }
      })
      .finally(() => alive && setProbing(false));
    return () => {
      alive = false;
    };
  }, [roomParam, joined]);

  const enter = (c: string) => {
    setStoredName(name.trim());
    const code = c.toUpperCase();
    setRoomUrl(code);
    setJoined(code);
  };
  const goHome = () => {
    setRoomUrl(null);
    setRoomParam(null);
    setJoined(null);
  };

  if (joined) return <RoomView code={joined} name={name.trim()} onLeave={goHome} />;
  if (probing) {
    return (
      <div className="app">
        <div className="panel">
          <p className="muted">Loading game…</p>
        </div>
      </div>
    );
  }
  return (
    <div className="app">
      <Landing
        name={name}
        setName={setName}
        initialCode={roomParam ?? ""}
        onHost={async () => enter(await createRoom())}
        onJoin={enter}
      />
    </div>
  );
}

function RoomView({ code, name, onLeave }: { code: string; name: string; onLeave: () => void }) {
  const room = useRoom(code, name);
  const { state, connected } = room;
  const inGame = !!state && (state.phase === "playing" || state.phase === "pending");
  return (
    <div className={`app${inGame ? " app-game" : ""}`}>
      {!state ? (
        <div className="panel">
          <p className="muted">{connected ? "joining…" : "connecting…"}</p>
          <button className="cta" onClick={onLeave}>
            Back
          </button>
        </div>
      ) : state.phase === "lobby" ? (
        <Lobby room={room} onLeave={onLeave} />
      ) : state.phase === "gameover" ? (
        <EndScreen state={state} onLeave={onLeave} />
      ) : (
        <Game room={room} onLeave={onLeave} />
      )}
      {/* Mid-session drop: we have state but lost the socket — show a reconnect veil. */}
      {state && !connected && <Reconnecting />}
    </div>
  );
}
