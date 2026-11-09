#!/usr/bin/env node
// Serves Code.gs over HTTP with in-memory stand-ins for the Apps Script services it uses, so the conformance
// suite can check its logic before a real deployment. Usage: node local-harness.mjs [port]
// Like a real web app it always answers 200 and sets no CORS header; run the suite with --relaxed-headers.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const files = new Map();
const iterator = (values) => { let i = 0; return { hasNext: () => i < values.length, next: () => values[i++] }; };
const file = (name) => ({
  getBlob: () => ({ getDataAsString: () => files.get(name) }),
  setContent: (text) => files.set(name, text),
  setTrashed: () => files.delete(name),
});
const folder = {
  getFilesByName: (name) => iterator(files.has(name) ? [file(name)] : []),
  getFiles: () => iterator([...files.keys()].map(file)),
  createFile: (name, text) => { files.set(name, text); return file(name); },
};
const context = vm.createContext({
  JSON, Math, Number, Object, Array, Date, String, RegExp,
  DriveApp: { getFoldersByName: () => iterator([folder]), createFolder: () => folder },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: { newBlob: (text) => ({ getBytes: () => Buffer.from(text, 'utf8') }) },
  MimeType: { PLAIN_TEXT: 'text/plain' },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
  },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ create: () => {} }) }) }) },
});
vm.runInContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Code.gs'), 'utf8'), context);

const port = Number(process.argv[2] ?? 8788);
createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const pathInfo = new URL(request.url, 'http://x').pathname.slice(1);
    const event = { pathInfo, postData: { contents: Buffer.concat(chunks).toString('utf8') } };
    const output = request.method === 'POST' ? context.doPost(event) : context.doGet(event);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(output.text);
  });
}).listen(port, () => console.log(`apps-script harness on http://localhost:${port}`));
