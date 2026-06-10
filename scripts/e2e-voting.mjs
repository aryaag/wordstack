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

  // A plays two tiles across the center.
  const aR = rackOf(game, "A");
  let mp = B.mark();
  A.send({ type: "submit_move", placed: [{ row: 4, col: 4, letter: aR[0] }, { row: 4, col: 5, letter: aR[1] }] });
  await B.waitFrom(mp, isType("move_pending"), "B sees pending");

  // B challenges → must enter review (NOT resolve immediately with 3 players).
  let mr = C.mark();
  B.send({ type: "challenge_word", wordIndex: 0 });
  await C.waitFrom(mr, stateWith((g) => g.pending && g.pending.stage === "review"), "entered review");
  game = C.latest();
  assert(game.phase === "pending" && game.pending.stage === "review", "challenge opens review, not instant reject");
  assert(game.pending.challengerId === "B", "challenger recorded as B");

  // Allow path: B withdraws (allow) and C allows → unanimous allow → move plays.
  const mApplied = A.mark();
  B.send({ type: "vote_move", vote: "allow" });
  C.send({ type: "vote_move", vote: "allow" });
  await A.waitFrom(mApplied, isType("move_applied"), "unanimous allow → move_applied");
  await A.waitFrom(mApplied, stateWith((g) => g.phase === "playing" && g.turnSeat === 1), "turn → B");
  ok("allow path: word played");

  // Reject path: B (seat 1) plays; C challenges; A allows but C upholds → rejected.
  game = B.latest();
  const bR = rackOf(game, "B");
  const bTile = bR.find((t) => t !== "s" && t !== "d") ?? bR[0];
  mp = C.mark();
  B.send({ type: "submit_move", placed: [{ row: 4, col: 6, letter: bTile }] });
  await C.waitFrom(mp, isType("move_pending"), "C sees B's pending");
  mr = A.mark();
  C.send({ type: "challenge_word", wordIndex: 0 });
  await A.waitFrom(mr, stateWith((g) => g.pending && g.pending.stage === "review"), "review again");
  const mRej = B.mark();
  A.send({ type: "vote_move", vote: "allow" }); // A is fine
  // C keeps its implicit reject (from challenging) → not unanimous allow.
  await B.waitFrom(mRej, isType("move_rejected"), "one reject → move_rejected");
  game = B.latest();
  assert(game.turnSeat === 1, "still B's turn after rejection (replay)");
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
