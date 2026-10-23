-- Official Chat SDK PostgreSQL state schema, pinned to adapter 4.43.0.
CREATE TABLE IF NOT EXISTS chat_state_subscriptions (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_prefix, thread_id)
  );
CREATE TABLE IF NOT EXISTS chat_state_locks (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_prefix, thread_id)
  );
CREATE TABLE IF NOT EXISTS chat_state_cache (
    key_prefix text NOT NULL,
    cache_key text NOT NULL,
    value text NOT NULL,
    expires_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_prefix, cache_key)
  );
CREATE INDEX IF NOT EXISTS chat_state_locks_expires_idx
    ON chat_state_locks (expires_at);
CREATE INDEX IF NOT EXISTS chat_state_cache_expires_idx
    ON chat_state_cache (expires_at);
CREATE TABLE IF NOT EXISTS chat_state_lists (
    key_prefix text NOT NULL,
    list_key text NOT NULL,
    seq bigserial NOT NULL,
    value text NOT NULL,
    expires_at timestamptz,
    PRIMARY KEY (key_prefix, list_key, seq)
  );
CREATE INDEX IF NOT EXISTS chat_state_lists_expires_idx
    ON chat_state_lists (expires_at);
CREATE TABLE IF NOT EXISTS chat_state_queues (
    key_prefix text NOT NULL,
    thread_id text NOT NULL,
    seq bigserial NOT NULL,
    value text NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (key_prefix, thread_id, seq)
  );
CREATE INDEX IF NOT EXISTS chat_state_queues_expires_idx
    ON chat_state_queues (expires_at);
