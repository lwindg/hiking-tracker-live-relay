// Hiking Tracker live report relay for Google Apps Script (live-report-v1 §5).
// Stores only random ids and sealed envelopes, one Drive file per mailbox, in a folder of the deploying account.
// Apps Script cannot set HTTP statuses, so refusals are 200 with {"error": <status>}, which the app understands.
// Setup: run `setup` once (creates the folder and a daily cleanup trigger), then Deploy > New deployment > Web app,
// "Execute as: Me", "Who has access: Anyone", and paste the /exec URL into the app.

const FOLDER_NAME = 'ht-live-relay';
const LIMITS = {
  bodyBytes: 65536, stateChars: 8192, chunkChars: 49152, chunksPerEpoch: 256, chunkCharsPerEpoch: 1048576,
  devicesPerMailbox: 32, minPostGapSeconds: 15, maxLifetimeSeconds: 60 * 86400,
};
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function setup() {
  folder_();
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'cleanup').forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).create();
}

function doGet(e) {
  const parts = (e.pathInfo || '').split('/');
  if (parts.length === 2 && parts[0] === 'v1' && parts[1] === 'health') return reply_({ protocol: 'ht-live', versions: [1] });
  if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'm') return reply_(read_(parts[2], now_()));
  return reply_({ error: 404 });
}

function doPost(e) {
  const parts = (e.pathInfo || '').split('/');
  if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== 'm') return reply_({ error: 404 });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return reply_(write_(parts[2], parts[3], parts[4], (e.postData && e.postData.contents) || '', now_()));
  } finally {
    lock.releaseLock();
  }
}

function cleanup() {
  const now = now_();
  const files = folder_().getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const mailbox = parse_(file.getBlob().getDataAsString());
    if (mailbox === null || mailbox.expiresAt <= now) file.setTrashed(true);
  }
}

function read_(mailboxId, now) {
  if (!isId_(mailboxId, 16)) return { error: 400 };
  const mailbox = load_(mailboxId, now);
  const devices = Object.keys(mailbox.devices).map((key) => {
    const device = mailbox.devices[key];
    return {
      slotId: device.slotId, deviceId: device.deviceId, receivedAt: device.receivedAt, state: device.state,
      chunks: Object.keys(device.chunks).map((seq) => device.chunks[seq]).sort((a, b) => a.seq - b.seq),
    };
  });
  return { devices: devices };
}

function write_(mailboxId, slotId, deviceId, text, now) {
  if (!isId_(mailboxId, 16) || !isId_(slotId, 8) || !isId_(deviceId, 8)) return { error: 400 };
  if (Utilities.newBlob(text).getBytes().length > LIMITS.bodyBytes) return { error: 413 };
  const body = parse_(text);
  if (body === null || typeof body !== 'object' || !Number.isInteger(body.expiresAt)) return { error: 400 };
  if (!Array.isArray(body.items) || body.items.length === 0 || !body.items.every(isEnvelope_)) return { error: 400 };
  if (body.expiresAt <= now) return { error: 410 };
  const items = body.items.map((i) => ({ v: i.v, kind: i.kind, epoch: i.epoch, seq: i.seq, n: i.n, c: i.c }));
  if (items.some((i) => i.c.length > (i.kind === 'state' ? LIMITS.stateChars : LIMITS.chunkChars))) return { error: 413 };
  const mailbox = load_(mailboxId, now);
  const key = slotId + '/' + deviceId;
  const stored = mailbox.devices[key];
  if (stored && now - stored.receivedAt < LIMITS.minPostGapSeconds) return { error: 429 };
  if (!stored && Object.keys(mailbox.devices).length >= LIMITS.devicesPerMailbox) return { error: 413 };
  const next = items.reduce((current, item) => {
    const day = item.epoch > current.epoch ? { epoch: item.epoch, state: null, chunks: {} } : current;
    if (item.epoch < day.epoch) return day;
    if (item.kind === 'state') return Object.assign({}, day, { state: item });
    const chunks = Object.assign({}, day.chunks);
    chunks[item.seq] = item;
    return Object.assign({}, day, { chunks: chunks });
  }, stored || { epoch: -1, state: null, chunks: {} });
  const chunkList = Object.keys(next.chunks).map((seq) => next.chunks[seq]);
  if (chunkList.length > LIMITS.chunksPerEpoch || chunkList.reduce((t, c) => t + c.c.length, 0) > LIMITS.chunkCharsPerEpoch) return { error: 413 };
  mailbox.devices[key] = { slotId: slotId, deviceId: deviceId, receivedAt: now, epoch: next.epoch, state: next.state, chunks: next.chunks };
  mailbox.expiresAt = Math.max(mailbox.expiresAt, Math.min(body.expiresAt, now + LIMITS.maxLifetimeSeconds));
  save_(mailboxId, mailbox);
  return { receivedAt: now };
}

function isEnvelope_(item) {
  return item !== null && typeof item === 'object' && !Array.isArray(item) && item.v === 1 &&
    Number.isInteger(item.epoch) && item.epoch >= 0 && Number.isInteger(item.seq) && isB64_(item.n) && isB64_(item.c) &&
    ((item.kind === 'state' && item.seq === 0) || (item.kind === 'chunk' && item.seq >= 1));
}

function isB64_(text) {
  return typeof text === 'string' && text.length > 0 && BASE64URL.test(text) && text.length % 4 !== 1;
}

function isId_(text, bytes) {
  return isB64_(text) && text.length === Math.ceil((bytes * 4) / 3);
}

function load_(mailboxId, now) {
  const files = folder_().getFilesByName(mailboxId + '.json');
  const mailbox = files.hasNext() ? parse_(files.next().getBlob().getDataAsString()) : null;
  return mailbox && mailbox.expiresAt > now ? mailbox : { expiresAt: 0, devices: {} };
}

function save_(mailboxId, mailbox) {
  const folder = folder_();
  const files = folder.getFilesByName(mailboxId + '.json');
  const text = JSON.stringify(mailbox);
  if (files.hasNext()) files.next().setContent(text);
  else folder.createFile(mailboxId + '.json', text, MimeType.PLAIN_TEXT);
}

function folder_() {
  const found = DriveApp.getFoldersByName(FOLDER_NAME);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER_NAME);
}

function parse_(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function now_() {
  return Math.floor(Date.now() / 1000);
}

function reply_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
