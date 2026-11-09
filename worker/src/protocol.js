// live-report-v1 §5: request checks, limits and the merge rule, without any storage.
// Kept free of Cloudflare APIs so the same rules can be read next to the Kotlin reference relay.

export const LIMITS = Object.freeze({
  bodyBytes: 65_536,
  stateChars: 8_192,
  chunkChars: 49_152,
  chunksPerEpoch: 256,
  chunkCharsPerEpoch: 1_048_576,
  devicesPerMailbox: 32,
  minPostGapSeconds: 15,
  maxLifetimeSeconds: 60 * 86_400,
});

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const isBase64Url = (text, bytes) =>
  typeof text === 'string' && text.length > 0 && BASE64URL.test(text) && text.length % 4 !== 1 &&
  (bytes === undefined || text.length === Math.ceil((bytes * 4) / 3));

export const isMailboxId = (text) => isBase64Url(text, 16);
export const isShortId = (text) => isBase64Url(text, 8);

const isInteger = (value) => typeof value === 'number' && Number.isInteger(value);

export const isEnvelope = (item) =>
  item !== null && typeof item === 'object' && !Array.isArray(item) &&
  item.v === 1 && isInteger(item.epoch) && item.epoch >= 0 && isInteger(item.seq) &&
  isBase64Url(item.n) && isBase64Url(item.c) &&
  ((item.kind === 'state' && item.seq === 0) || (item.kind === 'chunk' && item.seq >= 1));

/** Parses a POST body; returns { status } on refusal or { expiresAt, items }. */
export const readPost = (text) => {
  if (new TextEncoder().encode(text).length > LIMITS.bodyBytes) return { status: 413 };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 400 };
  }
  if (body === null || typeof body !== 'object' || !isInteger(body.expiresAt)) return { status: 400 };
  if (!Array.isArray(body.items) || body.items.length === 0 || !body.items.every(isEnvelope)) return { status: 400 };
  const envelope = ({ v, kind, epoch, seq, n, c }) => ({ v, kind, epoch, seq, n, c });
  return { expiresAt: body.expiresAt, items: body.items.map(envelope) };
};

export const tooLarge = (items) =>
  items.some((item) => item.c.length > (item.kind === 'state' ? LIMITS.stateChars : LIMITS.chunkChars));

/**
 * Applies items to a device ({ epoch, state, chunks: {seq: envelope} }); a later epoch drops the earlier day,
 * an earlier one is ignored. Returns the new device or { status: 413 } when the day would exceed its limits.
 */
export const merge = (device, items) => {
  const next = items.reduce((current, item) => {
    const day = item.epoch > current.epoch ? { epoch: item.epoch, state: null, chunks: {} } : current;
    if (item.epoch < day.epoch) return day;
    return item.kind === 'state'
      ? { ...day, state: item }
      : { ...day, chunks: { ...day.chunks, [item.seq]: item } };
  }, device);
  const chunks = Object.values(next.chunks);
  const chars = chunks.reduce((total, chunk) => total + chunk.c.length, 0);
  return chunks.length > LIMITS.chunksPerEpoch || chars > LIMITS.chunkCharsPerEpoch ? { status: 413 } : next;
};

export const emptyDevice = () => ({ epoch: -1, state: null, chunks: {} });

export const clampExpiry = (expiresAt, now) => Math.min(expiresAt, now + LIMITS.maxLifetimeSeconds);

export const sortedChunks = (chunks) => Object.values(chunks).sort((a, b) => a.seq - b.seq);
