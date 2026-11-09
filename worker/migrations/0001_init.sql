-- live-report-v1 §5: the relay keeps only random ids, sealed envelopes and times.
CREATE TABLE IF NOT EXISTS mailboxes (
  mailbox_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  mailbox_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  state TEXT,
  chunks TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, slot_id, device_id)
);
CREATE INDEX IF NOT EXISTS mailboxes_expiry ON mailboxes (expires_at);
