// 3-player challenge/voting E2E for the under-review deliberation flow.
//   BASE=http://localhost:8787 node scripts/e2e-voting.mjs

const HTTP = process.env.BASE || "http://localhost:8787";
const WS = HTTP.replace(/^http/, "ws");
let passed = 0;
const ok = (m) => (passed++, console.log(`  ✓ ${m}`));
const assert = (c, m) => {
  if (!c) throw new Error(`ASSERT FAILED: ${m}`);
  ok(m);
};
const CLIENTS = [];

class Client {
  constructor(name) {
    this.name = name;
    this.q = [];
    this.listeners = new Set();
  }
  async connect(code) {
    this.ws = new WebSocket(`${WS}/room/${code}/ws`);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", rej, { once: true });
    });
    this.ws.addEventListener("message", (e) => {
      this.q.push(JSON.parse(e.data));
      for (const l of [...this.listeners]) l();
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  mark() {
    return this.q.length;
  }
  waitFrom(mark, pred, label, t = 12000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        for (let i = mark; i < this.q.length; i++)
          if (pred(this.q[i])) {
            clearTimeout(timer);
            this.listeners.delete(check);
            return resolve(this.q[i]);
          }
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`[${this.name}] timeout: ${label}`));
      }, t);
      this.listeners.add(check);
      check();
    });
  }
  latest() {
    for (let i = this.q.length - 1; i >= 0; i--) if (this.q[i].type === "state") return this.q[i].game;
    return null;
  }
}

const isType = (t) => (m) => m.type === t;
const stateWith = (p) => (m) => m.type === "state" && p(m.game);
const rackOf = (g, id) => g.players.find((p) => p.id === id).rack;

async function main() {
  console.log(`Voting E2E against ${HTTP}`);
  const { code } = await (await fetch(`${HTTP}/room`, { method: "POST" })).json();
  const [A, B, C] = [new Client("A"), new Client("B"), new Client("C")];
  CLIENTS.push(A, B, C);
  await Promise.all([A.connect(code), B.connect(code), C.connect(code)]);

  let m = A.mark();
  A.send({ type: "join", playerId: "A", name: "Alice" });
  await A.waitFrom(m, stateWith((g) => g.players.length === 1), "A in");
  m = A.mark();
  B.send({ type: "join", playerId: "B", name: "Bob" });
  C.send({ type: "join", playerId: "C", name: "Cara" });
  await A.waitFrom(m, stateWith((g) => g.players.length === 3), "all 3 joined");
  ok("3 players joined");

  let mA = A.mark();
  A.send({ type: "start_game" });
  await A.waitFrom(mA, stateWith((g) => g.phase === "playing"), "playing");
  let game = A.latest();

  // Roles are derived from turnSeat (the starting player is randomized), not
  // hardcoded: S = current submitter, V1 = challenger, V2 = the other voter.
  const byId = { A, B, C };
  const roles = (g) => {
    const sId = g.players[g.turnSeat].id;
    const others = g.players.filter((p) => p.id !== sId).map((p) => p.id);
    return { S: byId[sId], V1: byId[others[0]], V2: byId[others[1]], sId, c1: others[0], c2: others[1] };
  };

  // ── Allow path (the regression case for the premature-resolution bug) ──
  let { S, V1, V2, sId, c1, c2 } = roles(game);
  const sR = rackOf(game, sId);
  let mp = V1.mark();
  S.send({ type: "submit_move", placed: [{ row: 4, col: 4, letter: sR[0] }, { row: 4, col: 5, letter: sR[1] }] });
  await V1.waitFrom(mp, isType("move_pending"), "challenger sees pending");

  // V1 challenges → must enter review (NOT resolve immediately with 3 players).
  let mr = V2.mark();
  V1.send({ type: "challenge_word", wordIndex: 0 });
  await V2.waitFrom(mr, stateWith((g) => g.pending && g.pending.stage === "review"), "entered review");
  game = V2.latest();
  assert(game.phase === "pending" && game.pending.stage === "review", "challenge opens review, not instant reject");
  assert(game.pending.challengerId === c1, "challenger recorded");

  // Regression guard: the challenger must start NEUTRAL (not pre-locked to reject).
  assert(game.pending.votes[c1] === undefined, "challenger starts with NO pre-set vote (neutral)");

  // The OTHER non-submitter votes allow FIRST. This must NOT resolve the move —
  // the challenger hasn't voted yet. (The old bug: the challenger's pre-set reject
  // made this resolve instantly as a rejection the moment the other voter clicked.)
  let mC = V2.mark();
  V2.send({ type: "vote_move", vote: "allow" });
  await V2.waitFrom(mC, stateWith((g) => g.pending?.votes[c2] === "allow"), "other voter's allow recorded");
  game = V2.latest();
  assert(
    game.phase === "pending" && game.pending.stage === "review",
    "still under review after only one voter — challenger can still change mind",
  );

  // Now the challenger reconsiders and allows → unanimous allow → move plays.
  const startSeat = game.turnSeat;
  const mApplied = S.mark();
  V1.send({ type: "vote_move", vote: "allow" });
  await S.waitFrom(mApplied, isType("move_applied"), "unanimous allow → move_applied");
  await S.waitFrom(mApplied, stateWith((g) => g.phase === "playing" && g.turnSeat === (startSeat + 1) % 3), "turn advances");
  ok("allow path: challenger changed mind, word played");

  // ── Reject path: new submitter plays; a challenger upholds → rejected ──
  game = S.latest();
  ({ S, V1, V2, sId, c1, c2 } = roles(game));
  const seat2 = game.turnSeat;
  const s2R = rackOf(game, sId);
  const tile = s2R.find((t) => t !== "s" && t !== "d") ?? s2R[0];
  mp = V1.mark();
  S.send({ type: "submit_move", placed: [{ row: 4, col: 6, letter: tile }] });
  await V1.waitFrom(mp, isType("move_pending"), "challenger sees pending (round 2)");
  mr = V2.mark();
  V1.send({ type: "challenge_word", wordIndex: 0 });
  await V2.waitFrom(mr, stateWith((g) => g.pending && g.pending.stage === "review"), "review again");
  const mRej = S.mark();
  V2.send({ type: "vote_move", vote: "allow" }); // the other voter is fine
  V1.send({ type: "vote_move", vote: "reject" }); // challenger must now explicitly uphold (no implicit reject)
  await S.waitFrom(mRej, isType("move_rejected"), "one reject → move_rejected");
  game = S.latest();
  assert(game.turnSeat === seat2, "still submitter's turn after rejection (replay)");
  ok("reject path: word sent back");

  console.log(`\n✅ ALL ${passed} CHECKS PASSED`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  for (const c of CLIENTS) {
    console.error(`--- ${c.name} ---`);
    for (const msg of c.q.slice(-5)) console.error("  " + JSON.stringify(msg).slice(0, 150));
  }
  process.exit(1);
});
