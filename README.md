# Hiking Tracker live report relay

The relay lets guardians see each member's last position and the day's track while a plan is under way. The wire
protocol is in [`PROTOCOL.md`](https://github.com/lwindg/hiking-tracker-live-relay/blob/main/PROTOCOL.md).

This folder is published as the public repo
[lwindg/hiking-tracker-live-relay](https://github.com/lwindg/hiking-tracker-live-relay) by
`scripts/publish-live-relay.sh` in the app's repo; edit it there, not in the public copy.

It is a dumb mailbox. Phones encrypt every report with the plan's key before sending it, so the relay only ever
holds random ids, sealed bytes and times. It cannot tell who is reporting, where they are or which mountain the trip
is on. Mailboxes are deleted 7 days after the plan's last day.

The person who creates a plan turns on **Position reports** on the plan page. The app asks for a relay address the
first time (and remembers it), tests it by writing and reading back one sealed report, and stores it in the plan. The
address can be changed later from the same section. Members and guardians get the relay address inside the plan file
and set up nothing. Deploy one of the two versions below to get an address of your own.

## Option 1: Cloudflare Workers (recommended)

Needs a free Cloudflare account and a GitHub or GitLab account. No credit card. On the free plan the relay stops
answering when a daily limit is reached; it never bills.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lwindg/hiking-tracker-live-relay/tree/main/worker)

1. Press the button and sign in. Cloudflare copies `worker/` into your account, creates the D1 database named in
   `wrangler.jsonc`, and deploys.
2. Open the deployed Worker and copy its URL, for example `https://ht-live-relay.<you>.workers.dev`.
3. In the app, paste it when turning on Position reports. The app writes one sealed test report and reads it back
   before using the address.

From the command line instead:

```sh
cd worker
npm install
npx wrangler d1 create ht-live-relay        # put the printed database_id into wrangler.jsonc
npx wrangler d1 migrations apply ht-live-relay --remote
npx wrangler deploy
```

Free plan headroom (Cloudflare documentation, October 2026): 100,000 requests and 100,000 D1 row writes per day.
One report is one request and one or two row writes; a member reporting every 15 minutes for 12 hours uses about
50 of each. A daily cron trigger deletes expired mailboxes.

## Option 2: Google Apps Script

Needs only a Google account. Reports are stored as files in a Drive folder named `ht-live-relay` in that account.
It is slower than Option 1 and suits a small team.

1. Go to <https://script.google.com>, create a project, and replace `Code.gs` with
   [`apps-script/Code.gs`](apps-script/Code.gs).
2. Run the function `setup` once and allow the requested Drive and trigger permissions. It creates the folder and a
   daily cleanup trigger.
3. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*.
4. Copy the `/exec` URL and paste it when the app asks for the relay address.

Apps Script cannot set HTTP status codes or CORS headers. It answers refusals as `200 {"error": <status>}`, which
the app understands. The web viewer (planned) needs Option 1.

## Checking a relay

The conformance suite runs the same cases the app's tests use:

```sh
node conformance/run.mjs https://ht-live-relay.<you>.workers.dev
node conformance/run.mjs https://script.google.com/macros/s/<id>/exec --relaxed-headers
```

It creates a few mailboxes with fresh random ids, which expire within a day. Cases that need a moving clock run only
in the app's own tests.

For local work, `npm run dev` in `worker/` serves the Worker on port 8787 with a local D1, and
`node apps-script/local-harness.mjs` serves `Code.gs` on port 8788 with in-memory stand-ins for Drive.

## Privacy and limits

- Stored: mailbox id, member slot id, device id (all random), sealed envelopes, receive times, the mailbox expiry.
- Never stored: names, phone numbers, plan contents, or any readable position.
- Anyone holding a plan file can read that plan's reports, and could also write fake ones. Share plan files only
  with members and guardians.
- Limits per request and per day are listed in [`PROTOCOL.md`](PROTOCOL.md), §5.

## License

MIT, see [`LICENSE`](LICENSE).
