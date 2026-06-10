import { useEffect, useState } from "react";
import { createRoom, getStoredName, setStoredName, useRoom } from "./useRoom";
import { Landing, Lobby, NamePrompt } from "./Landing";
import { Game } from "./Game";
import "./App.css";

const roomFromUrl = () => new URLSearchParams(location.search).get("room");
function setRoomUrl(code: string | null) {
  const url = new URL(location.href);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  history.pushState({}, "", url);
}

export function App() {
  const [code, setCode] = useState<string | null>(roomFromUrl());
  const [name, setName] = useState(getStoredName());

  useEffect(() => {
    const onpop = () => setCode(roomFromUrl());
    addEventListener("popstate", onpop);
    return () => removeEventListener("popstate", onpop);
  }, []);

  const go = (c: string | null) => {
    setRoomUrl(c);
    setCode(c);
  };

  if (!code) {
    return (
      <div className="app">
        <Landing
          name={name}
          setName={setName}
          onHost={async () => {
            setStoredName(name.trim());
            go(await createRoom());
          }}
          onJoin={(c) => {
            setStoredName(name.trim());
            go(c.toUpperCase());
          }}
        />
      </div>
    );
  }
  // A room link was opened without a name yet → ask for it before joining.
  if (!name.trim()) {
    return (
      <div className="app">
        <NamePrompt
          code={code}
          onSubmit={(n) => {
            setStoredName(n);
            setName(n);
          }}
          onCancel={() => go(null)}
        />
      </div>
    );
  }
  return <RoomView code={code} name={name.trim()} onLeave={() => go(null)} />;
}

function RoomView({ code, name, onLeave }: { code: string; name: string; onLeave: () => void }) {
  const room = useRoom(code, name);
  const { state, connected } = room;
  return (
    <div className="app">
      {!state ? (
        <div className="panel">
          <p className="muted">{connected ? "joining…" : "connecting…"}</p>
          <button className="cta" onClick={onLeave}>
            Back
          </button>
        </div>
      ) : state.phase === "lobby" ? (
        <Lobby room={room} onLeave={onLeave} />
      ) : (
        <Game room={room} onLeave={onLeave} />
      )}
    </div>
  );
}
