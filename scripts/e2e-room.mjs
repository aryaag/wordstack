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

  // The starting player is randomized, so derive roles from turnSeat rather than
  // assuming the host goes first: S = submitter, O = the other player.
  const startSeat = game.turnSeat;
  const oSeat = (startSeat + 1) % 2;
  const byId = { A, B };
  const sId = game.players[startSeat].id;
  const oId = game.players[oSeat].id;
  const S = byId[sId];
  const O = byId[oId];
  assert(startSeat === 0 || startSeat === 1, `starting player chosen (seat ${startSeat}, ${sId})`);

  // 3. S plays 2 tiles across the center → O accepts → applied
  const sRack = rackOf(game, sId);
  let mp = O.mark();
  S.send({
    type: "submit_move",
    placed: [
      { row: 4, col: 4, letter: sRack[0] },
      { row: 4, col: 5, letter: sRack[1] },
    ],
  });
  const pend = await O.waitFrom(mp, isType("move_pending"), "O gets move_pending");
  assert(pend.totalPoints > 0, `move_pending with ${pend.totalPoints} tentative points`);
  const ma = S.mark();
  O.send({ type: "acknowledge_move" });
  const applied = await S.waitFrom(ma, isType("move_applied"), "move_applied");
  await S.waitFrom(ma, stateWith((g) => g.phase === "playing" && g.turnSeat === oSeat), "committed, turn → O");
  game = S.latestState();
  assert(applied.points > 0 && game.players[startSeat].score === applied.points, "S scored the move");
  assert(occupied(game.board) === 2, "2 tiles committed to the board");
  assert(rackOf(game, sId).length === 7, "S's rack refilled to 7");

  // 4. O plays one (non s/d) extending tile → S challenges → rejected.
  // With a single opponent the lone challenge resolves immediately as a rejection.
  const oRack = rackOf(game, oId);
  const oTile = oRack.find((t) => t !== "s" && t !== "d") ?? oRack[0];
  let mpS = S.mark();
  O.send({ type: "submit_move", placed: [{ row: 4, col: 6, letter: oTile }] });
  await S.waitFrom(mpS, isType("move_pending"), "S gets O's move_pending");
  const mr = O.mark();
  S.send({ type: "challenge_word", wordIndex: 0 });
  const result = await O.waitFrom(mr, isType("challenge_result"), "challenge_result");
  assert(result.challenged.length === 1 && result.challenged[0].by.includes(sId), "S's challenge recorded");
  await O.waitFrom(mr, isType("move_rejected"), "lone challenge → immediate move_rejected");
  await O.waitFrom(mr, stateWith((g) => g.phase === "playing"), "back to playing after reject");
  game = O.latestState();
  assert(occupied(game.board) === 2, "board unchanged after rejection");
  assert(game.turnSeat === oSeat, "still O's turn (replay)");

  // 5. O passes → turn to S
  let ms = O.mark();
  O.send({ type: "pass" });
  await O.waitFrom(ms, stateWith((g) => g.turnSeat === startSeat && g.phase === "playing"), "pass rotates to S");
  ok("pass works");

  // 6. S swaps a tile → tile changes, turn to O
  game = S.latestState();
  const bagBefore = game.bagCount;
  ms = S.mark();
  S.send({ type: "swap_tiles", index: 0 });
  await S.waitFrom(ms, stateWith((g) => g.turnSeat === oSeat && g.phase === "playing"), "swap rotates to O");
  game = S.latestState();
  assert(rackOf(game, sId).length === 7, "rack still 7 after swap");
  assert(game.bagCount === bagBefore, "swap keeps the bag count the same");

  // 7. reconnect mid-pending: O submits, drop S, reconnect S, expect pending in state
  mpS = S.mark();
  O.send({ type: "submit_move", placed: [{ row: 4, col: 6, letter: oTile }] });
  await S.waitFrom(mpS, isType("move_pending"), "pending opened for reconnect test");
  S.close();
  const S2 = new Client(`${sId}2`);
  CLIENTS.push(S2);
  await S2.connect(code);
  const m2 = S2.mark();
  S2.send({ type: "join", playerId: sId, name: "Rejoin" });
  const snap = await S2.waitFrom(m2, stateWith((g) => g.pending !== null), "reconnect snapshot has pending");
  assert(snap.game.pending.stage === "open", "reconnect snapshot shows the open stage");
  const m3 = S2.mark();
  S2.send({ type: "acknowledge_move" });
  await S2.waitFrom(m3, isType("move_applied"), "reconnected player accepts → applied");

  console.log(`\n✅ ALL ${passed} CHECKS PASSED`);
  S2.close();
  O.close();
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
