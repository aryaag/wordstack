import { useEffect, useState } from "react";
import {
  clearRoomJoined,
  createRoom,
  getStoredName,
  isRoomJoined,
  markRoomJoined,
  setStoredName,
  useRoom,
} from "./useRoom";
import { HomePage, JoinPage, Lobby } from "./Landing";
import { Game } from "./Game";
import { EndScreen, Reconnecting } from "./overlays";
import "./App.css";

type Route = { page: "home" } | { page: "join"; code: string } | { page: "game"; code: string };

/** Path-based routing: `/` home, `/join` join, `/game?room=CODE` play. A bare `/`
 *  (even with a legacy `?room`) is always home. */
function parseRoute(): Route {
  const code = (new URLSearchParams(location.search).get("room") ?? "").toUpperCase();
  if (location.pathname === "/game") return { page: "game", code };
  if (location.pathname === "/join") return { page: "join", code };
  return { page: "home" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [name, setName] = useState(getStoredName());

  // Keep the route in sync with browser back/forward.
  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = (path: string) => {
    history.pushState({}, "", path);
    setRoute(parseRoute());
  };

  if (route.page === "game" && route.code) {
    return <GameRoute code={route.code} name={name.trim()} go={go} />;
  }
  if (route.page === "join") {
    return (
      <div className="app">
        <JoinPage
          name={name}
          setName={setName}
          initialCode={route.code}
          onJoin={(c) => {
            const code = c.toUpperCase();
            setStoredName(name.trim());
            markRoomJoined(code);
            go(`/game?room=${code}`);
          }}
        />
      </div>
    );
  }
  return (
    <div className="app">
      <HomePage
        name={name}
        setName={setName}
        onHost={async () => {
          setStoredName(name.trim());
          const code = await createRoom();
          markRoomJoined(code);
          go(`/game?room=${code}`);
        }}
        onJoinNav={() => go("/join")}
      />
    </div>
  );
}

/** `/game?room=CODE`: only render the room if this browser officially joined this
 *  code (host or join). Otherwise (someone shared the game URL, not the invite
 *  link) bounce to `/join` for the same code. */
function GameRoute({ code, name, go }: { code: string; name: string; go: (path: string) => void }) {
  const joined = isRoomJoined(code);
  useEffect(() => {
    if (!joined) go(`/join?room=${code}`);
  }, [joined, code, go]);
  if (!joined) return null;
  return (
    <RoomView
      code={code}
      name={name}
      onLeave={() => {
        clearRoomJoined(code);
        go("/");
      }}
      onJoinFailed={() => {
        clearRoomJoined(code); // stale marker (room gone / started / full)
        go("/");
      }}
    />
  );
}

function RoomView({
  code,
  name,
  onLeave,
  onJoinFailed,
}: {
  code: string;
  name: string;
  onLeave: () => void;
  onJoinFailed: () => void;
}) {
  const room = useRoom(code, name);
  const { state, connected, joinError } = room;

  // The server rejected us before we ever joined (room gone / started / full) —
  // clear the stale marker and head home with the notice.
  useEffect(() => {
    if (joinError) onJoinFailed();
  }, [joinError, onJoinFailed]);

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
      ) : state.phase === "gameover" || state.phase === "rematch_pending" ? (
        <EndScreen
          state={state}
          me={room.me}
          notice={room.notice}
          onRematch={room.rematch}
          onRematchVote={room.rematchVote}
          onLeave={onLeave}
        />
      ) : (
        <Game room={room} onLeave={onLeave} />
      )}
      {/* Mid-session drop: we have state but lost the socket — show a reconnect veil. */}
      {state && !connected && <Reconnecting />}
    </div>
  );
}
