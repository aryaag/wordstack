import { useState } from "react";
import { createRoom, getStoredName, setStoredName, useRoom } from "./useRoom";
import { Landing, Lobby } from "./Landing";
import { Game } from "./Game";
import { EndScreen } from "./overlays";
import "./App.css";

const roomFromUrl = () => new URLSearchParams(location.search).get("room");
function setRoomUrl(code: string | null) {
  const url = new URL(location.href);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  history.replaceState({}, "", url);
}

export function App() {
  // `joined` = the room the player has actually committed to (drives the room view).
  // A `?room=` link does NOT auto-join — it only pre-fills the code on the landing
  // page, so the player can adjust their name and join themselves.
  const [joined, setJoined] = useState<string | null>(null);
  const [name, setName] = useState(getStoredName());

  const enter = (c: string) => {
    setStoredName(name.trim());
    const code = c.toUpperCase();
    setRoomUrl(code);
    setJoined(code);
  };

  if (!joined) {
    return (
      <div className="app">
        <Landing
          name={name}
          setName={setName}
          initialCode={roomFromUrl() ?? ""}
          onHost={async () => enter(await createRoom())}
          onJoin={enter}
        />
      </div>
    );
  }
  return <RoomView code={joined} name={name.trim()} onLeave={() => { setRoomUrl(null); setJoined(null); }} />;
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
    </div>
  );
}
