// Hiking Tracker live report relay, live-report-v1 §5. Stores sealed envelopes under random ids and never decrypts.
import { LIMITS, clampExpiry, emptyDevice, isMailboxId, isShortId, merge, readPost, sortedChunks, tooLarge } from './protocol.js';

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const refuse = (status) => json(status, { error: status });

const nowSeconds = () => Math.floor(Date.now() / 1000);

const liveMailbox = async (db, mailboxId, now) => {
  const row = await db.prepare('SELECT expires_at FROM mailboxes WHERE mailbox_id = ?').bind(mailboxId).first();
  if (row === null || row.expires_at > now) return row;
  await db.batch([
    db.prepare('DELETE FROM devices WHERE mailbox_id = ?').bind(mailboxId),
    db.prepare('DELETE FROM mailboxes WHERE mailbox_id = ?').bind(mailboxId),
  ]);
  return null;
};

const read = async (db, mailboxId, now) => {
  if (!isMailboxId(mailboxId)) return refuse(400);
  const mailbox = await liveMailbox(db, mailboxId, now);
  const rows = mailbox === null ? [] : (await db
    .prepare('SELECT slot_id, device_id, received_at, state, chunks FROM devices WHERE mailbox_id = ?')
    .bind(mailboxId).all()).results;
  const devices = rows.map((row) => ({
    slotId: row.slot_id,
    deviceId: row.device_id,
    receivedAt: row.received_at,
    state: row.state === null ? null : JSON.parse(row.state),
    chunks: sortedChunks(JSON.parse(row.chunks)),
  }));
  return json(200, { devices }, { 'access-control-allow-origin': '*' });
};

const write = async (db, mailboxId, slotId, deviceId, text, now) => {
  if (!isMailboxId(mailboxId) || !isShortId(slotId) || !isShortId(deviceId)) return refuse(400);
  const post = readPost(text);
  if (post.status) return refuse(post.status);
  if (post.expiresAt <= now) return refuse(410);
  if (tooLarge(post.items)) return refuse(413);
  const mailbox = await liveMailbox(db, mailboxId, now);
  const stored = await db
    .prepare('SELECT received_at, epoch, state, chunks FROM devices WHERE mailbox_id = ? AND slot_id = ? AND device_id = ?')
    .bind(mailboxId, slotId, deviceId).first();
  if (stored !== null && now - stored.received_at < LIMITS.minPostGapSeconds) return refuse(429);
  if (stored === null && mailbox !== null) {
    const { count } = await db.prepare('SELECT COUNT(*) AS count FROM devices WHERE mailbox_id = ?').bind(mailboxId).first();
    if (count >= LIMITS.devicesPerMailbox) return refuse(413);
  }
  const current = stored === null ? emptyDevice()
    : { epoch: stored.epoch, state: stored.state === null ? null : JSON.parse(stored.state), chunks: JSON.parse(stored.chunks) };
  const next = merge(current, post.items);
  if (next.status) return refuse(next.status);
  const expiresAt = Math.max(mailbox === null ? 0 : mailbox.expires_at, clampExpiry(post.expiresAt, now));
  await db.batch([
    db.prepare('INSERT INTO mailboxes (mailbox_id, expires_at) VALUES (?, ?) ON CONFLICT (mailbox_id) DO UPDATE SET expires_at = excluded.expires_at')
      .bind(mailboxId, expiresAt),
    db.prepare(`INSERT INTO devices (mailbox_id, slot_id, device_id, received_at, epoch, state, chunks) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (mailbox_id, slot_id, device_id) DO UPDATE SET received_at = excluded.received_at, epoch = excluded.epoch,
      state = excluded.state, chunks = excluded.chunks`)
      .bind(mailboxId, slotId, deviceId, now, next.epoch, next.state === null ? null : JSON.stringify(next.state), JSON.stringify(next.chunks)),
  ]);
  return json(200, { receivedAt: now });
};

export default {
  async fetch(request, env) {
    const now = nowSeconds();
    const parts = new URL(request.url).pathname.split('/').slice(1);
    if (request.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'health') {
      return json(200, { protocol: 'ht-live', versions: [1] }, { 'access-control-allow-origin': '*' });
    }
    if (request.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'm') {
      return read(env.DB, parts[2], now);
    }
    if (request.method === 'POST' && parts.length === 5 && parts[0] === 'v1' && parts[1] === 'm') {
      return write(env.DB, parts[2], parts[3], parts[4], await request.text(), now);
    }
    return refuse(404);
  },

  async scheduled(_event, env) {
    const now = nowSeconds();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM devices WHERE mailbox_id IN (SELECT mailbox_id FROM mailboxes WHERE expires_at <= ?)').bind(now),
      env.DB.prepare('DELETE FROM mailboxes WHERE expires_at <= ?').bind(now),
    ]);
  },
};
