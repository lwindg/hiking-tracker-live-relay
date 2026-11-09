# Live Report v1 Contract (payload, encryption, relay protocol, report policy)


## 1. Identifiers and key material

All values are random bytes encoded as base64url without padding. JVM and Android draw them from `SecureRandom`; iOS reads `/dev/urandom` directly, because RoboVM's default `SecureRandom` is the pre-Android-4.4 Harmony `SHA1PRNG` (CVE-2013-7372).

| Value | Bytes | Encoded length | Scope |
|---|---|---|---|
| `key` | 32 | 43 | One per plan. Rotating it also replaces `mailboxId` and every `slotId`. |
| `mailboxId` | 16 | 22 | One per plan. Knowing it is the capability to read and write. |
| `slotId` | 8 | 11 | One per plan member, `self` included. Never a person id. Never reused within a plan. |
| `deviceId` | 8 | 11 | One per (install, plan), created on the first report. Never a hardware id. |

## 2. Encryption

- Algorithm: AES-256-GCM, 12-byte random nonce per item, 128-bit tag appended to the ciphertext.
- Associated data, UTF-8: `ht-live-v1|{mailboxId}|{slotId}|{deviceId}|{kind}|{epoch}|{seq}`. A blob moved to another slot, device, kind, epoch or sequence fails to decrypt.
- Envelope (what the relay stores; the only thing it ever sees besides ids):

```json
{ "v": 1, "kind": "state", "epoch": 2, "seq": 0, "n": "<nonce b64url>", "c": "<ciphertext+tag b64url>" }
```

- `kind` is `state` or `chunk`. `seq` is `0` for `state` and starts at `1` for chunks within an epoch.
- `epoch` is the 0-based recorded day (FR-139) of the report. It is the only plaintext field with meaning, and it is needed so the relay can drop the previous day's chunks.
- Decrypt failure (wrong key, tampering, moved blob) is reported per device as `UNREADABLE`, never as a crash and never as "no report".
- Implementations (T001, 2026-11-09): JVM and Android use JCA (`JcaAesGcm`). RoboVM's JCA cannot add associated data (`BaseBlockCipher` has no `engineUpdateAAD`), so iOS uses the runtime's BouncyCastle `GCMBlockCipher` directly (`RoboVmAesGcm`). Both are checked against `contracts/fixtures/live-crypto-vectors.json` (McGrew–Viega test cases 13 and 16 plus one envelope vector), and the iOS one also natively through `--ui-test-crypto-probe`.

## 3. Plaintext payloads

Encoded with `JsonObject.toString()` (RoboVM lacks `Long.compareUnsigned`, CLAUDE.md 2026-11-06). Unknown keys are rejected; `schema` other than 1 is `UNSUPPORTED`.

**state**

```json
{ "schema": 1, "reportedAt": 1795000000, "lat": 24.36521, "lon": 121.43012, "ele": 3480.5, "accuracyM": 8.0,
  "status": "MOVING", "batteryPct": 54, "reason": "INTERVAL", "intervalMin": 15, "epochPoints": 412 }
```

- `status`: `MOVING`, `RESTING`, `PAUSED`, `OVERNIGHT_PAUSED`, `FINISHED`.
- `reason`: `START`, `INTERVAL`, `HEARTBEAT`, `RECONNECT`, `DAY_END`, `FINISH`, `MANUAL`, `LOW_BATTERY`.
- `intervalMin`: the effective interval when sent (after rest, battery and backoff rules), or `null` in manual-only mode. Guardians use it for the overdue rule (§7).
- `ele`, `accuracyM`, `batteryPct` may be `null`. `epochPoints` is the number of simplified points sent so far in this epoch.

**chunk**

```json
{ "schema": 1, "points": [[1795000000, 24.36521, 121.43012, 3480.5], [1795000180, 24.36602, 121.43100, null]] }
```

- Each point is `[epochSeconds, lat, lon, ele|null]`; lat/lon rounded to 5 decimals, ele to 0.1 m.
- Points are strictly increasing in time across the chunks of one epoch.

## 4. Track simplification and deltas

- Source: the accepted samples of the current recorded day.
- Keep a sample when it is at least 30 m from the last kept point **or** at least 300 s after it. The newest sample is always sent as the last point of the request, even if it would not be kept; it is then kept.
- A request sends one new chunk holding every kept point after the last acknowledged chunk. On success the chunk's `seq` is acknowledged; on failure the same points are resent next time under the same `seq` (relay writes are idempotent per `seq`).
- A new epoch starts at `seq = 1`.

## 5. Relay protocol

Only `GET` and `POST` (Google Apps Script web apps have no `PUT`). Every refusal carries the body `{"error": <status>}`; a relay that cannot set HTTP statuses (Apps Script always answers 200) sends that body with 200, and clients treat a 2xx whose body is an object with an integer `error` as that status. Clients follow `302`/`303` with `GET` (Apps Script answers `POST` with a redirect). `{base}` is the plan's `relayUrl`, with no trailing slash. Apps Script receives the rest of the path in `e.pathInfo`.

| Request | Body | Success |
|---|---|---|
| `GET {base}/v1/health` | — | `200 {"protocol":"ht-live","versions":[1]}` |
| `POST {base}/v1/m/{mailboxId}/{slotId}/{deviceId}` | `{"expiresAt": epochSeconds, "items": [envelope, …]}` | `200 {"receivedAt": epochSeconds}` |
| `GET {base}/v1/m/{mailboxId}` | — | `200 {"devices":[{"slotId","deviceId","receivedAt","state": envelope or null,"chunks":[envelope, …]}]}` |

Relay semantics:

- A `state` item replaces the stored state of that device. A `chunk` item is stored under `(epoch, seq)`; the same key overwrites.
- When an item's `epoch` is greater than the device's stored epoch, the relay deletes that device's older chunks and older state. An item whose `epoch` is lower than the stored one is ignored (the request still succeeds).
- Envelope checks (`400`): `v` is 1; `kind` is `state` or `chunk`; `epoch` ≥ 0; `seq` is 0 for `state` and ≥ 1 for `chunk`; `n` and `c` are non-empty base64url; ids have the §1 lengths; `items` is a non-empty array; `expiresAt` is an integer.
- Any other path or method is `404`.
- `receivedAt` is the relay's clock when the `POST` was accepted.
- `expiresAt` is clamped to `now + 60 days`; the mailbox keeps the largest value seen. Expired mailboxes are deleted by a scheduled job at least daily, and are treated as unknown before deletion.
- `GET` of an unknown or expired mailbox returns `200 {"devices":[]}`, so "nobody has reported" never looks like an error.
- `GET` responses carry `Access-Control-Allow-Origin: *` (for the P2 web viewer). `POST` needs no CORS.

Limits (the relay enforces them; the client stays inside them):

| Limit | Value | Response |
|---|---|---|
| Request body | 64 KiB | `413` |
| `c` of one `state` | 8 KiB | `413` |
| `c` of one `chunk` | 48 KiB | `413` |
| Chunks per device per epoch | 256 | `413` |
| Total `c` length of one device's chunks in one epoch | 1,048,576 characters (a walking day is about 50 KB; one D1 row holds a device, and a row is at most 2 MB) | `413` |
| Devices per mailbox | 32 | `413` |
| Minimum gap between `POST`s from one device | 15 s | `429` |
| Malformed id, envelope or JSON | — | `400` |
| `expiresAt` already in the past | — | `410` |

## 6. Send outcome classification (FR-LPR-029)

| Outcome | Condition | Client behaviour |
|---|---|---|
| `OK` | `2xx` with a valid body | acknowledge chunk, record `lastSuccessAt` |
| `NETWORK` | connect failure, DNS failure, timeout (connect 10 s, total 30 s), TLS failure | exponential backoff (§8) |
| `SERVICE` | `429`, any `5xx`, a `2xx` whose body does not parse, and every status not listed in this table (for example a Cloudflare 1027 page or a `403` from a proxy) | wait 60 min, show "report service unavailable" |
| `REJECTED` | exactly `400`, `404`, `410`, `413` | stop automatic reports for this plan, keep manual off too, show the reason |

The recording itself is never affected by any outcome.

## 7. Guardian view rules

`liveMemberRows(copy, fetch, now)` returns one row per (slot, device), in slot order, then a row per slot that has no device ("not reported").

- Name: from the copy's `liveReport.slots[].name`. A slot with two devices shows both, labelled "device 1", "device 2" in `receivedAt` order.
- Time: `reportedAt` with "x h y min ago". When `|receivedAt − reportedAt| > 600 s` both are shown.
- Overdue: `now − reportedAt > 2 × intervalMin` when `intervalMin` is not null, and the status is not `FINISHED` or `OVERNIGHT_PAUSED`.
- Fetch failure keeps the last cached result and shows its fetch time (FR-LPR-031). The cache is `live-report-cache/<planId>.json`, holding the last successful `GET` body and `fetchedAt`; it is local only, never backed up.
- No position is ever interpolated or extrapolated.

## 8. Report policy (FR-LPR-020–028)

`liveReportDecision(input): LiveReportDecision` is pure and is the only place that decides whether to send.

Input: `now`, `event` (`SAMPLE`, `NETWORK_UP`, `START`, `DAY_END`, `FINISH`, `MANUAL`), `intervalMin` (5/15/30/60 or `null` = manual only), `status`, `movedSinceLastSuccessM`, `batteryPct`, `networkUsable`, `inFlight`, `lastSuccessAt`, `lastAttemptAt`, `failureStreak`, `lastFailure` (`NETWORK`/`SERVICE`/null), `stopped` (`LOW_BATTERY`/`REJECTED`/null), `manualQueued`.

Output: `SEND(reason)` or `WAIT(manualQueued)`.

Rules, first match wins:

1. `inFlight` → `WAIT`.
2. `stopped = REJECTED` → `WAIT`.
3. `networkUsable = false` → `WAIT`, with `manualQueued = true` when the event is `MANUAL`.
4. `MANUAL`: `SEND(MANUAL)` unless the last attempt was less than 30 s ago.
5. `NETWORK_UP` with `manualQueued` → `SEND(MANUAL)`.
6. `stopped = LOW_BATTERY` or `intervalMin = null` → `WAIT`.
7. `START`, `DAY_END`, `FINISH` → `SEND` with that reason.
8. Backoff gate: after a failure, wait `60 min` for `SERVICE`, or `min(intervalMin × 2^(failureStreak − 1), 60 min)` for `NETWORK`, counted from `lastAttemptAt`; otherwise `WAIT`.
9. `batteryPct < 10` → `SEND(LOW_BATTERY)`; after it succeeds the caller sets `stopped = LOW_BATTERY` (cleared when the next recording starts). It comes after the backoff gate so a flaky network at low battery cannot retry on every sample (2026-11-09, found while writing T008).
10. `NETWORK_UP` → `SEND(RECONNECT)` when `lastSuccessAt` is null or more than 2 min ago.
11. Effective interval: `intervalMin`, raised to 60 min when the status is `RESTING`/`PAUSED`, or `movedSinceLastSuccessM < 50`, or `batteryPct < 20`. `SAMPLE` → `SEND(INTERVAL)` (or `HEARTBEAT` when raised by rest or no movement) once `now − lastSuccessAt ≥` the effective interval; `SEND(INTERVAL)` when `lastSuccessAt` is null.
12. Otherwise `WAIT`.

Platform duties (the only ones):

- Call the policy with `SAMPLE` on every **raw location callback**, before `TrackRecorder` filtering. Accepted samples alone are not enough: while standing still they stop (`minDistanceM` 25 m), and the heartbeat would never fire.
- Call it on the events.
- Report `networkUsable` from the OS (Android: `NET_CAPABILITY_INTERNET` and `NET_CAPABILITY_VALIDATED`; iOS: path `satisfied`); emit `NETWORK_UP` after the network has stayed usable for 10 s.
- Fallback wake: when no location callback has arrived for the current effective interval (Android `POWER_SAVER` uses a 10 m distance filter, so a resting phone may get none; iOS at `HundredMeters` while resting may be sparse), schedule one inexact wake at `lastCallbackAt + effective interval` and call the policy with `SAMPLE` then. Android uses `setAndAllowWhileIdle` like the stationary reminder; iOS uses a main-run-loop timer (the app is running in the background while recording). Every callback reschedules it. No wake is scheduled while `OVERNIGHT_PAUSED`, `FINISHED`, `stopped` or manual-only.
- Never poll; never send a probe request.
- An event other than `SAMPLE` within 18 s of the last attempt (the relay's 15 s plus 3 s for clock skew and latency) waits until then before the policy is asked, on the same report thread, so the relay's minimum gap (§5) never turns a finish or day-end report into a `429` (2026-11-09, found by the Android native run).

The per-device client state (`live-report/<planId>.json`: `deviceId`, last acknowledged `epoch`/`seq`, simplifier cursor, `lastSuccessAt`, `lastAttemptAt`, `failureStreak`, `lastFailure`, `stopped`, `manualQueued`) is written atomically after every attempt and whenever the simplifier keeps a point (§4), so a killed app loses no kept point. It is not part of the whole-app backup: after a restore the phone reports under a new `deviceId`, and the old device's row disappears when the mailbox expires (2026-11-09: keeps the backup bundle contract unchanged). A state file that cannot be read starts over the same way; the guardian then sees a gap in that day's track, never a wrong position.
