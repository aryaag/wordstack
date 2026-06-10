import { useState } from "react";
import { getStoredName, type RoomConn } from "./useRoom";
import { Icon, Tile } from "./lib";

const LOGO = "UPWORDS".split("");
const RAISED: Record<number, number> = { 0: 2, 3: 3 }; // index → height badge + raised edge

export function Landing({
  name,
  setName,
  onHost,
  onJoin,
}: {
  name: string;
  setName: (n: string) => void;
  onHost: () => void;
  onJoin: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const host = async () => {
    setBusy(true);
    try {
      await onHost();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <div className="logo">
        {LOGO.map((l, i) => (
          <Tile key={i} letter={l} height={RAISED[i] ?? 1} />
        ))}
      </div>
      <p className="tagline">Stack letters, climb words</p>
      <p className="sub">
        A 10×10 word game where tiles stack up
        <br />
        and taller words score higher.
      </p>

      <input
        className="field"
        placeholder="Your name"
        value={name}
        maxLength={16}
        onChange={(e) => setName(e.target.value)}
        style={{ marginBottom: name.trim() ? 14 : 6 }}
      />
      {!name.trim() && <p className="muted" style={{ margin: "0 0 12px" }}>Enter a name to host or join.</p>}
      <button className="cta primary" onClick={host} disabled={busy || !name.trim()}>
        <Icon name="plus" /> Host a game
      </button>

      <div className="or">
        <div />
        <span>or join with a code</span>
        <div />
      </div>
      <input
        className="code-input"
        placeholder="CODE"
        value={code}
        maxLength={6}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
      />
      <button
        className="cta"
        style={{ marginTop: 10 }}
        disabled={!code.trim() || !name.trim()}
        onClick={() => onJoin(code.trim())}
      >
        Join game
      </button>
    </div>
  );
}

/** Shown when someone opens a room link but hasn't set a name yet. */
export function NamePrompt({
  code,
  onSubmit,
  onCancel,
}: {
  code: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(getStoredName());
  const submit = () => {
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <div className="landing">
      <div className="logo">
        {LOGO.map((l, i) => (
          <Tile key={i} letter={l} height={RAISED[i] ?? 1} />
        ))}
      </div>
      <p className="tagline">Joining room {code}</p>
      <p className="sub">Enter your name so other players know who you are.</p>
      <input
        className="field"
        placeholder="Your name"
        value={name}
        maxLength={16}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        style={{ marginBottom: 14 }}
      />
      <button className="cta primary" disabled={!name.trim()} onClick={submit}>
        Join game
      </button>
      <button className="cta" style={{ marginTop: 10 }} onClick={onCancel}>
        Back
      </button>
    </div>
  );
}

export function Lobby({ room, onLeave }: { room: RoomConn; onLeave: () => void }) {
  const { state, me, start } = room;
  if (!state) return null;
  const isHost = state.hostId === me;
  return (
    <>
      <div className="appbar">
        <span className="brand">
          <span className="mini">U</span> Upwords
        </span>
        <button
          className="icon-btn"
          onClick={() => {
            room.leave();
            onLeave();
          }}
          aria-label="Leave"
        >
          <Icon name="leave" size={20} />
        </button>
      </div>
      <div className="panel">
        <h2>Game lobby</h2>
        <p className="muted">Share this code so friends can join:</p>
        <p className="code-big">{state.code}</p>
        <ul className="players-list">
          {state.players.map((p) => (
            <li key={p.id}>
              <b>{p.name}</b>
              <span className="muted">
                {p.id === state.hostId ? "host" : ""}
                {p.id === me ? " · you" : ""}
                {p.connected ? "" : " · away"}
              </span>
            </li>
          ))}
        </ul>
        {isHost ? (
          <button className="cta primary" disabled={state.players.length < 2} onClick={start}>
            Start game ({state.players.length}/4)
          </button>
        ) : (
          <p className="muted">Waiting for the host to start…</p>
        )}
      </div>
    </>
  );
}
