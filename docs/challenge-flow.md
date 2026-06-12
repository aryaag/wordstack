# Validation mode & challenge flow

Implemented in [`worker/src/room.ts`](../worker/src/room.ts) (the room DO).
Message/state shapes are in [`worker/src/protocol.ts`](../worker/src/protocol.ts)
— see `PendingMove`, `PendingStage`, and the `ClientMessage`/`ServerMessage`
unions, which are the source of truth for wire names.

Default mode: `"challenge"`. Server config: `VALIDATION_MODE: "auto" |
"challenge"` + `challengePenalty: boolean` (default `false`).

## Resolution is by HUMAN CONSENSUS — not the dictionary
D1 is **never** consulted during gameplay (validity, including trivial
plurals/past-tense, is entirely human-decided; the lexicon DB backs only the
standalone `GET /validate` endpoint — see [architecture.md](architecture.md)). A
challenge does **not** reject instantly — it pauses the game into a review/vote,
and the move plays only if **every** non-submitter allows it. Any single upheld
challenge (a "not valid" vote) rejects the whole move.

## Two-stage post-submit flow
On submit, the DO hard-validates **placement only** (immediate `error` if broken,
no popup), extracts words + tentative scores, enters `pending` with stage
`"open"`, sets a 30s **DO Alarm** (alarms survive hibernation; never
`setTimeout`), and broadcasts `move_pending`.

**Open stage** — all players see the words + tentative points. Non-submitters can
**Accept** or **Challenge** (the submitter's popup is read-only). A 30s countdown
auto-accepts the unresolved. If every non-submitter accepts, or the timer fires
with no challenge → the move commits (`move_applied`).

**Review stage** — the moment any non-submitter challenges a word, the move enters
stage `"review"`: the auto-accept timer **pauses** (a long DO-Alarm backstop only
prevents a permanent hang), the table deliberates out loud, and every
non-submitter casts a **vote on the word's validity** — framed as *"Is WORD a
valid word? Yes (valid) / No (not valid)"*, explicitly **not** a vote on whether
the challenge was fair. One clarifying sentence sits directly above the Yes/No
buttons. **Everyone — the challenger included — starts NEUTRAL** (no vote
pre-selected) so the table can deliberate and change their minds; the act of
challenging is not pre-locked to "not valid". Resolution waits until every
non-submitter has actually voted (or the backstop fires).

**Resolution** (when all non-submitters have voted, or the backstop fires with
unvoted = allow):
- **All allow** → `move_applied` (committed, scored, rack refilled).
- **Any reject** → the entire move is rejected: the submitter takes the tiles back
  and replays. The DO broadcasts `challenge_result` then `move_rejected`. No D1
  check, no turn skip for the challenger.

**Single opponent (2 players, or 3–4 with only one active non-submitter left):**
there's no one else to deliberate with, so a challenge resolves immediately — the
lone challenger's No stands, resolved inline without broadcasting the review stage
(no vote-popup flash).

A move is always accepted or rejected **as a unit** — no partial acceptance. The
**View definition** action (Merriam-Webster lookup; see
[architecture.md](architecture.md)) is a separate, informational button and never
counts as a vote.

## Reconnect
On reconnect the DO sends the full current `state` snapshot. If a post-submit
popup is in progress, the snapshot includes the pending move, the current
per-player accept/challenge state, and the rejoining player's remaining countdown
so they can render the popup correctly.
