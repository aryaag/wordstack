// End-to-end driver for the Phase 4 room DO. Runs a full 2-player game over
// WebSockets against a running worker (default local wrangler dev).
//
//   BASE=http://localhost:8787 node scripts/e2e-room.mjs
//
// Every wait scans only messages that arrive AFTER a mark taken before the
// triggering send, so stale broadcasts can't satisfy a later wait. Exits 0 on
// success, 1 on any failed assertion.

const HTTP = process.env.BASE || "http://localhost:8787";
const WS = HTTP.replace(/^http/, "ws");

let passed = 0;
const ok = (m) => (passed++, console.log(`  ✓ ${m}`));
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  ok(msg);
}

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
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  close() {
    this.ws.close();
  }
  mark() {
    return this.q.length;
  }
  waitFrom(mark, pred, label, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        for (let i = mark; i < this.q.length; i++) {
          if (pred(this.q[i])) {
            clearTimeout(t);
            this.listeners.delete(check);
            resolve(this.q[i]);
            return;
          }
        }
      };
      const t = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`[${this.name}] timeout waiting for ${label}`));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }
  latestState() {
    for (let i = this.q.length - 1; i >= 0; i--) if (this.q[i].type === "state") return this.q[i].game;
    return null;
  }
}

const occupied = (board) => board.flat().filter((c) => c.length > 0).length;
const rackOf = (game, id) => game.players.find((p) => p.id === id).rack;
const stateWith = (pred) => (m) => m.type === "state" && pred(m.game);
const isType = (t) => (m) => m.type === t;

async function main() {
  console.log(`E2E against ${HTTP}`);

  // 1. create + join
  const { code } = await (await fetch(`${HTTP}/room`, { method: "POST" })).json();
  assert(typeof code === "string" && code.length === 6, `created room ${code}`);

  const A = new Client("A");
  const B = new Client("B");
  CLIENTS.push(A, B);
  await A.connect(code);
  await B.connect(code);

  let m = A.mark();
  A.send({ type: "join", playerId: "A", name: "Alice" });
  await A.waitFrom(m, stateWith((g) => g.players.length === 1), "A seated");
  m = A.mark();
  B.send({ type: "join", playerId: "B", name: "Bob" });
  await A.waitFrom(m, stateWith((g) => g.players.length === 2), "B seated");
  ok("both players joined");

  // 2. start
  const mA = A.mark();
  const mB = B.mark();
  A.send({ type: "start_game" });
  await A.waitFrom(mA, stateWith((g) => g.phase === "playing"), "A sees playing");
  await B.waitFrom(mB, stateWith((g) => g.phase === "playing"), "B sees playing");
  let game = A.latestState();
  assert(game.players.every((p) => p.rack.length === 7), "both racks dealt to 7");
  assert(game.turnSeat === 0, "turn starts with host (seat 0)");

  // 3. A plays 2 tiles across the center → B accepts → applied
  const aRack = rackOf(game, "A");
  let mp = B.mark();
  A.send({
    type: "submit_move",
    placed: [
      { row: 4, col: 4, letter: aRack[0] },
      { row: 4, col: 5, letter: aRack[1] },
    ],
  });
  const pend = await B.waitFrom(mp, isType("move_pending"), "B gets move_pending");
  assert(pend.totalPoints > 0, `move_pending with ${pend.totalPoints} tentative points`);
  const ma = A.mark();
  B.send({ type: "acknowledge_move" });
  const applied = await A.waitFrom(ma, isType("move_applied"), "move_applied");
  await A.waitFrom(ma, stateWith((g) => g.phase === "playing" && g.turnSeat === 1), "committed, turn → B");
  game = A.latestState();
  assert(applied.points > 0 && game.players[0].score === applied.points, "A scored the move");
  assert(occupied(game.board) === 2, "2 tiles committed to the board");
  assert(rackOf(game, "A").length === 7, "A's rack refilled to 7");

  // 4. B plays one (non s/d) extending tile → A challenges → rejected
  const bRack = rackOf(game, "B");
  const bTile = bRack.find((t) => t !== "s" && t !== "d") ?? bRack[0];
  let mpA = A.mark();
  B.send({ type: "submit_move", placed: [{ row: 4, col: 6, letter: bTile }] });
  await A.waitFrom(mpA, isType("move_pending"), "A gets B's move_pending");
  const mr = B.mark();
  A.send({ type: "challenge_word", wordIndex: 0 });
  const result = await B.waitFrom(mr, isType("challenge_result"), "challenge_result");
  assert(result.challenged.length === 1 && result.challenged[0].by.includes("A"), "A's challenge recorded");
  await B.waitFrom(mr, isType("move_rejected"), "move_rejected");
  await B.waitFrom(mr, stateWith((g) => g.phase === "playing"), "back to playing after reject");
  game = B.latestState();
  assert(occupied(game.board) === 2, "board unchanged after rejection");
  assert(game.turnSeat === 1, "still B's turn (replay)");

  // 5. B passes → turn to A
  let ms = B.mark();
  B.send({ type: "pass" });
  await B.waitFrom(ms, stateWith((g) => g.turnSeat === 0 && g.phase === "playing"), "pass rotates to A");
  ok("pass works");

  // 6. A swaps a tile → tile changes, turn to B
  game = A.latestState();
  const bagBefore = game.bagCount;
  ms = A.mark();
  A.send({ type: "swap_tiles", index: 0 });
  await A.waitFrom(ms, stateWith((g) => g.turnSeat === 1 && g.phase === "playing"), "swap rotates to B");
  game = A.latestState();
  assert(rackOf(game, "A").length === 7, "rack still 7 after swap");
  assert(game.bagCount === bagBefore, "swap keeps the bag count the same");

  // 7. reconnect mid-pending: B submits, drop A, reconnect A, expect pending in state
  mpA = A.mark();
  B.send({ type: "submit_move", placed: [{ row: 4, col: 6, letter: bTile }] });
  await A.waitFrom(mpA, isType("move_pending"), "pending opened for reconnect test");
  A.close();
  const A2 = new Client("A2");
  CLIENTS.push(A2);
  await A2.connect(code);
  const m2 = A2.mark();
  A2.send({ type: "join", playerId: "A", name: "Alice" });
  const snap = await A2.waitFrom(m2, stateWith((g) => g.pending !== null), "reconnect snapshot has pending");
  assert(snap.game.pending.deadline > Date.now(), "pending deadline is in the future");
  const m3 = A2.mark();
  A2.send({ type: "acknowledge_move" });
  await A2.waitFrom(m3, isType("move_applied"), "reconnected player accepts → applied");

  console.log(`\n✅ ALL ${passed} CHECKS PASSED`);
  A2.close();
  B.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  for (const c of CLIENTS) {
    console.error(`\n--- ${c.name} last messages ---`);
    for (const msg of c.q.slice(-6)) console.error("   " + JSON.stringify(msg).slice(0, 160));
  }
  process.exit(1);
});
