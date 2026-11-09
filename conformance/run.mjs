#!/usr/bin/env node
// Runs live-relay/conformance/cases.json against a relay URL (live-report-v1 §5).
// Usage: node run.mjs <baseUrl> [--relaxed-headers]     e.g. node run.mjs http://localhost:8787
// Exit code 0 only when every case that does not need a virtual clock passes. Each case uses fresh random ids.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
// Apps Script cannot set response headers (live-report-v1 §5); --relaxed-headers skips the header checks for it.
const relaxedHeaders = process.argv.includes('--relaxed-headers');
if (!/^https?:\/\/.+/.test(base)) {
  console.error('usage: node run.mjs <baseUrl>');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));
const placeholder = /\{(mb2?|slot2?|dev(?::\d+|:i|2)?|now(?:[+-]\d+)?|i|rep:([^:}]+):(\d+))\}/g;
const base64url = (bytes) => randomBytes(bytes).toString('base64url');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Math.floor(Date.now() / 1000);

const idsFor = () => {
  const values = new Map();
  return (name) => {
    if (!values.has(name)) values.set(name, base64url(name.startsWith('mb') ? 16 : 8));
    return values.get(name);
  };
};

const substitute = (value, ids, index) => {
  if (Array.isArray(value)) return value.map((item) => substitute(item, ids, index));
  if (value !== null && typeof value === 'object') {
    if ('$repeat' in value) return Array.from({ length: value.$repeat }, (_, i) => substitute(value.item, ids, i + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, ids, index)]));
  }
  if (typeof value !== 'string') return value;
  const whole = value.match(/^\{now([+-]\d+)?\}$/);
  if (whole) return now() + Number(whole[1] ?? 0);
  if (value === '{i}') return index;
  return value.replace(placeholder, (_, name, text, count) => {
    if (name.startsWith('rep:')) return text.repeat(Number(count));
    if (name === 'dev:i') return ids(`dev:${index}`);
    if (name === 'dev') return ids('dev:1');
    return ids(name);
  });
};

const matches = (expected, actual) => {
  if (expected === '$num') return typeof actual === 'number';
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => matches(item, actual[i]));
  }
  if (expected !== null && typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, item]) => key in actual && matches(item, actual[key]));
  }
  return expected === actual;
};

const runCase = async (testCase) => {
  const ids = idsFor();
  for (const step of testCase.steps) {
    if (step.advance) {
      await sleep(step.advance * 1000);
      continue;
    }
    for (let index = 1; index <= (step.repeat ?? 1); index += 1) {
      const path = substitute(step.path, ids, index);
      const body = step.rawBody ?? (step.body === undefined ? undefined : JSON.stringify(substitute(step.body, ids, index)));
      const response = await fetch(base + path, {
        method: step.method,
        body,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        redirect: 'follow',
      });
      const text = await response.text();
      const fail = (why) => { throw new Error(`${step.method} ${path}: ${why}; body ${text.slice(0, 300)}`); };
      const bodyError = (() => { try { const e = JSON.parse(text).error; return Number.isInteger(e) ? e : undefined; } catch { return undefined; } })();
      const status = response.status >= 200 && response.status < 300 && bodyError !== undefined ? bodyError : response.status;
      if (status !== step.expect.status) fail(`status ${status}, expected ${step.expect.status}`);
      for (const [name, value] of Object.entries(relaxedHeaders ? {} : step.expect.headers ?? {})) {
        if (response.headers.get(name) !== value) fail(`header ${name} = ${response.headers.get(name)}`);
      }
      if (step.expect.json && !matches(substitute(step.expect.json, ids, index), JSON.parse(text))) fail('body does not match');
      if (step.expect.jsonDevicesUnordered) {
        const devices = JSON.parse(text).devices;
        const wanted = substitute(step.expect.jsonDevicesUnordered, ids, index);
        if (devices.length !== wanted.length || !wanted.every((want) => devices.some((device) => matches(want, device)))) fail('devices do not match');
      }
      if (step.advanceAfter) await sleep(step.advanceAfter * 1000);
    }
  }
};

const runnable = cases.filter((testCase) => !testCase.virtualClockOnly);
const results = await Promise.all(runnable.map(async (testCase) => {
  try {
    await runCase(testCase);
    return { name: testCase.name, ok: true };
  } catch (error) {
    return { name: testCase.name, ok: false, error: error.message };
  }
}));
results.forEach((result) => console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : `\n     ${result.error}`}`));
const skipped = cases.length - runnable.length;
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed against ${base}; ${skipped} virtual-clock case(s) skipped`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
