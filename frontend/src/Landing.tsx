import { useState } from "react";
import { type RoomConn } from "./useRoom";
import { Icon, Tile } from "./lib";

const LOGO = "UPWORDS".split("");
const RAISED: Record<number, number> = { 0: 2, 3: 3 }; // index → height badge + raised edge

export function Landing({
  name,
  setName,
  initialCode = "",
  onHost,
  onJoin,
}: {
  name: string;
  setName: (n: string) => void;
  initialCode?: string; // pre-filled from a shared ?room= link
  onHost: () => void;
  onJoin: (code: string) => void;
}) {
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [busy, setBusy] = useState(false);
  const fromLink = !!initialCode;

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
        {fromLink ? (
          <>
            You’re invited to room <b>{code}</b>.
            <br />
            Confirm your name and join below.
          </>
        ) : (
          <>
            A 10×10 word game where tiles stack up
            <br />
            and taller words score higher.
          </>
        )}
      </p>

      <input
        className="field"
        placeholder="Your name"
        value={name}
        maxLength={16}
        autoFocus={fromLink}
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
        className={`cta${fromLink ? " primary" : ""}`}
        style={{ marginTop: 10 }}
        disabled={!code.trim() || !name.trim()}
        onClick={() => onJoin(code.trim())}
      >
        Join game
      </button>
    </div>
  );
}

export function Lobby({ room, onLeave }: { room: RoomConn; onLeave: () => void }) {
  const { state, me, start } = room;
  const [copied, setCopied] = useState(false);
  if (!state) return null;
  const isHost = state.hostId === me;
  const inviteLink = `${location.origin}/?room=${state.code}`;
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
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
        <p className="muted">Share this code (or the link) so friends can join:</p>
        <p className="code-big">{state.code}</p>
        <button className="cta" onClick={copyLink} style={{ marginBottom: 16 }}>
          <Icon name={copied ? "check" : "copy"} /> {copied ? "Invite link copied!" : "Copy invite link"}
        </button>
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
