-- Upwords lexicon — word-validity set membership only.
-- D1 holds ONLY this table; all live game state lives in the Durable Object.
-- Words are normal lowercase ASCII (the Qu tile is expanded to "qu" at lookup time).
CREATE TABLE IF NOT EXISTS words (
  word TEXT PRIMARY KEY
) WITHOUT ROWID;
