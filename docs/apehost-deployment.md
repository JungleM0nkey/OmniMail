# Apehost OmniMail replacement

Based on upstream OmniMail 1.3.0, commit `6f765dd`. Production remains
`https://mail.apehost.dev`; the temporary staging origin is
`https://omnimail.apehost.dev`. Staging deployment alone does not establish that
the inbox has been migrated or that production is ready to switch.

The replacement keeps `m0nkey@apehost.dev`, adds native Cloudflare Email sending
to OmniMail's existing queue, and permits framing by `https://console.apehost.dev`
and the mail origin itself. Other origins remain blocked. Authentication, message
ownership checks, outbound rate limits, private attachments and email-content
framing restrictions retain their existing implementation.

Cloudflare is a fallback when no Resend or SendFlare provider is configured.
Replies preserve threading headers and attachments. An uncertain send is never
automatically retried, including when Cloudflare accepts mail but D1 cannot record
it. Cloudflare's own message-size and sending limits still apply.

## Resources

Account: `7031244e5dbce80f897a55df4b7c859b`.

| Resource | Existing Mailflare | New OmniMail |
| --- | --- | --- |
| Worker | `mailflare` | `omni-mail` |
| D1 | `9e15235d-7c72-435e-8a76-09cc9c233c7d` | Separate `omni-mail-db`; cutover state pins its UUID |
| R2 mail | `mailflare-raw` | `omni-mail-storage` |
| R2 backups | Unchanged | `omni-mail-backups` |
| Mail queue | `mailflare-inbound` / `mailflare-outbound` / `mailflare-agent` | `omnimail-mail` and its dead-letter queue |
| Notification queue | Unchanged | `omnimail-notifications` and its dead-letter queue |

The upstream backup and cleanup Workflows remain available for explicit actions.
Cron triggers are empty. Periodic external-mail sync, scheduled backups and
scheduled cleanup are not enabled.

The existing inbox must be imported and independently verified. A fresh empty
inbox is not an acceptable replacement. Take a current private source snapshot;
historical message counts are not migration evidence. Keep snapshots, receipts,
cutover state and mailbox credentials outside this repository.

## Activation

1. Use the reviewed, merged source. Authenticate with Cloudflare OAuth. For Wrangler,
   exclude API-key/token overrides from the child process and use its own OAuth
   session; never put account credentials in this repository.
2. Stage the merged source using a temporary Wrangler configuration in the
   repository root: use `omnimail.apehost.dev` for its route and `APP_ORIGINS`.
   Do not deploy the final `mail.apehost.dev` route before initialization.
   `npm run deploy -- --config <staging-config>` provisions separate resources
   and applies the checked-in D1 migrations. Do not bind Mailflare's database.
3. Set a randomly generated `SETUP_TOKEN` Secret, initialize the configured owner,
   and create the `apehost.dev` domain and `m0nkey@apehost.dev` receiving address.
   Reuse the existing mailbox password from the owner's private local credential
   file without printing or committing it. Remove `SETUP_TOKEN` after setup.
4. Capture a stable, complete Mailflare baseline snapshot, import its mail/attachments, and run
   the independent verifier against the exact snapshot bytes. Verify owner login,
   private inbox and attachments, native sending, and console framing through the
   Browser Harness. Record separate parity and runtime receipts described below.
5. Capture original routing, create and verify independent backups, then use the
   guarded cutover command. Publish a final configuration with the final
   `APP_ORIGINS` and custom domain while preserving the already provisioned
   resource bindings. The existing MX, SPF, DKIM, DMARC and Email Sending
   onboarding stay in place. Verify real login, sending, inbound delivery and
   attachments through `mail.apehost.dev`, including a message received after
   the catch-all change.
6. After reversible routing cutover, drain and quiesce Mailflare producers and
   queues without purging. Capture the final source state, import its delta and
   independently verify it again. Back up that exact latest complete snapshot.
   Update runtime evidence after final acceptance and only then
   run guarded decommission. Remove the temporary OmniMail staging hostname
   separately after final acceptance; it is not a Mailflare resource.

Zone: `e2c7c4a817c98ffccf4b3e964bd9aa13`. Existing catch-all rule:
`889466d315cc4933ac305ddfa144439d`, enabled, all recipients, Worker `mailflare`.
Existing mail custom domain: `548a11fa307a67cb93aed82811dfb5f55afbb613`.
The obsolete embedding rule is `283b02e91d1d45a29abf79f38922d729` in ruleset
`1ab9208593e04c3292795c102a3c0aae`.

Rollback before decommission returns the hostname, saved routes and catch-all to
`mailflare`. It never deletes either set of storage. Mail received by OmniMail
after cutover must remain available and be reconciled. Once decommission begins,
automatic rollback is refused; restoration then requires rebuilding Mailflare
from retained backups.

## Guarded cutover tool

`scripts/apehost-cutover.mjs` uses Node's standard library and the existing local
Cloudflare OAuth helper. It never accepts API keys or API tokens. Serialize uses
of the shared OAuth helper: another process refreshing that session can invalidate
an in-flight reader. Keep `TEMP`, `TMP` and npm cache on a disk with free space.

The direct helper's OAuth session must cover the endpoints used by the chosen
command: account Workers/settings/deployments, Durable Object namespaces/objects,
D1, R2 buckets/objects, queue
configuration/metrics, zone DNS/routes/rulesets, Email Routing rules and Email
Sending subdomains. Read-only `status`/`audit` require all inventory read
permissions too. Routing changes and retirement additionally require write/delete
permissions for their exact resource types. The supported Email Routing/Sending
scopes needed here include `email-routing-rule.read`,
`email-routing-rule.write` and `email-sending.read`.

The live CLI inventory is currently blocked by the direct client's missing
Email Routing/Sending scopes: `GET /zones/<zone>/email/routing/rules` returns
HTTP 403, code 10000. The helper's existing session has separately passed D1,
R2 and Workers reads after its timestamp-refresh bug was corrected. A different
signed-in MCP session can read routing/sending; that does not grant the direct
helper those permissions. Configure the required scopes through the supported
OAuth client/dashboard flow and reauthorize that session before using this CLI.
Do not substitute API keys/tokens or treat a partial inventory as cutover
verification. This authorization prerequisite remains open; no production
cutover or source retirement is claimed by these instructions.

Every command defaults to a dry run. `status` and `audit` remain read-only even
with `--execute`. D1 `POST /query` requests contain only `SELECT` statements.
`--execute` also gates local state/backup writes. Private state paths must be
outside the repository. Do not edit saved deletion intents to bypass a refusal.

```powershell
rtk node scripts/apehost-cutover.mjs status
rtk node scripts/apehost-cutover.mjs audit
rtk node scripts/apehost-cutover.mjs prepare --state D:/private-mail/cutover-state.json
rtk node scripts/apehost-cutover.mjs prepare --state D:/private-mail/cutover-state.json --execute
```

Preparation captures all account Workers and their relevant resource bindings,
D1/R2/queues, the complete account Durable Object namespace catalog,
custom domains, the zone's routes/rulesets/email routing, DNS and
Email Sending subdomains. It requires the original Mailflare custom domain and
catch-all, a separately staged OmniMail database/storage/backups, and known queue
ownership. Later commands reject changed Worker identity/content, recreated
source queues/buckets, unexpected references or routing changes.

Email Routing rule inventory uses its 50-item page limit and consumes every
reported page. If that list includes the known catch-all, its identity and full
rule body must agree with the dedicated catch-all endpoint before it is separated
from ordinary rules. A conflicting entry or an extra rule forwarding to Mailflare
stops preparation. The saved catch-all name is preserved through cutover and
rollback; audit checks its actions for references rather than its historical name.

The only permitted source Durable Object is `mailflare_RealtimeHub`, namespace
`702f544aa78e480db6bb37f2aac86380`, class `RealtimeHub`, binding `REALTIME`.
The shipped Worker ETag must be exactly
`203f2efecc8d108bb8e7ea28c81068b06725d5f539dccd02c37e86f56194bd3c`.
Its independently audited shipped class uses WebSocket attachments for derived
user IDs and reads mail state from D1; it has no storage, SQL, transaction or
alarm calls. Mail bodies and attachments are persisted before notification.
The reviewed module SHA-256 is
`1ca6ac183d86b79010282f2b5ed3a1612a9d160667adfc9fb0434cc7c21b0985`.
Only its exact `WORKER_SELF_REFERENCE` service binding to `mailflare` in
`production` is allowed. Unknown namespaces/classes, foreign references,
changed code and missing or true `hasStoredData` flags stop retirement.

Preparation reads every namespace catalog page and follows the object's cursor
through its final empty cursor, even after a short page. Before saving success,
it creates `<state-path>.source-worker.json` outside the repository. This
immutable private archive contains the original Worker download bytes, HTTP
content type and ETag, full settings, namespace catalog and empty-object proof.
It is captured once and reused on resume. Do not edit or remove it: its hash is
pinned in state and it is required by later commands. The class audit and live
empty-object proof justify this one exception; they do not authorize discarding
storage from any other Durable Object.

The migration snapshot is a JSON object with `createdAt`, `account`, `database`,
`bucket`, `schema`, `tables` containing table-row arrays, and `objects` containing
`{key,size,sha256,base64}`. Capture a stable complete source state before import;
the snapshot file's exact bytes are bound to the independent verifier receipt.
`schema` must contain the full result of:

```sql
SELECT type, name, tbl_name, sql FROM sqlite_master
WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
ORDER BY type, name
```

Every entry has exactly `{type,name,tbl_name,sql}`, including indexes, triggers
and views. `tables` must contain exactly every schema entry of type `table`,
including FTS shadow tables. Missing/partial schema, omitted/extra table keys,
invalid row arrays and tables exceeding 10,000 rows cause refusal. Historical
snapshots with only table names/DDL do not meet this complete-backup contract.

During backup and reversible cutover, the tool checks that the full captured
schema still matches current D1. Every baseline message, attachment, mailbox and
domain row must remain unchanged and present on reads before and after checking
R2, and existing baseline messages cannot gain attachments. Every baseline R2
object must remain present with the same bytes. New messages/objects and changes
to derived tables such as contacts,
FTS, JMAP and spam reputation are allowed while Mailflare continues receiving.
All source resources remain available for rollback and the final delta import.

```powershell
rtk node scripts/apehost-cutover.mjs backup --state D:/private-mail/cutover-state.json --snapshot D:/private-mail/latest.json --parity-receipt D:/private-mail/parity.json
rtk node scripts/apehost-cutover.mjs backup --state D:/private-mail/cutover-state.json --snapshot D:/private-mail/latest.json --parity-receipt D:/private-mail/parity.json --execute
```

Backup preserves four artifacts locally and in the independent
`omni-mail-backups` bucket under
`mailflare-retirement/<snapshot-sha256>/<parity-receipt-sha256>/`:
the exact migration snapshot, captured complete D1 schema/rows, original control-plane
inventory and exact parity receipt. It downloads every uploaded artifact and
checks SHA-256 independently. Existing keys containing different bytes cause a
refusal. Cutover, rollback and decommission recheck both backup locations.
For the reviewed Hub, a fifth artifact, `source-worker.json`, preserves the
exact original Worker archive in both locations, with the same download/hash
checks. A missing or corrupted primary archive or backup copy stops progress.
Renewed verifier receipts for the same source snapshot get a separate immutable
namespace; earlier proof artifacts remain intact.

The D1 artifact is a canonical representation of the supplied snapshot's
schema/rows, labelled `captured-d1/v1` in state and command output. Its capture
time comes from the snapshot; backup verification time records when the copies
were checked. It is a point-in-time baseline, not a fresh export of unverified
arrivals during upload. Both backup locations are checked against that captured
artifact. Existing backups are never silently relabelled; use a complete snapshot
and new independently verified receipt. Baseline parity and routing cutover do
not establish that later Mailflare arrivals have already reached OmniMail.

```powershell
rtk node scripts/apehost-cutover.mjs cutover --state D:/private-mail/cutover-state.json --snapshot D:/private-mail/latest.json --parity-receipt D:/private-mail/parity.json --runtime-receipt D:/private-mail/runtime.json
```

Cutover and rollback transfer the existing custom domain through Wrangler's
worker-scoped `/workers/scripts/{worker}/domains/records` endpoint. The
account-level `/workers/domains` PUT attaches domains and returns 409 for this
existing hostname; it cannot perform the transfer. Execution first requests a
read-only changeset with `replace_state=false`, requiring exactly the saved domain
ID/zone/hostname, destination Worker and original enabled/preview flags, with no
additions, removals, conflicts or other affected zones. Publication uses
`override_scope:false`, `override_existing_origin:true` and
`override_existing_dns_record:false` with only that origin. Other custom domains
remain in place and their routing fields are checked after publication. Preview
certificate/environment placeholders are excluded from ownership comparisons.
All other domains' stable routing fields must match the saved preparation during
initial execution and every retry. Added, removed or changed unrelated domains
require reviewed fresh preparation/backups before transfer; certificate renewal
does not change this routing invariant. Do not edit or silently refresh existing
state to accept domain drift.

Ownership and routing flags are rechecked immediately after preview and before
publication. This endpoint exposes no conditional owner update, so these checks
cannot exclude an external writer changing the domain between the last read and
PUT. Keep other domain writers quiescent during the transfer. A saved domain-step
intent, including one left by the old 409 failure, resumes without clearing state.
After a lost response, exact owner/ID/flags and captured sibling domains must match
before the step is marked complete. Default dry runs validate current domain
identity/flags and plan the step; the fresh preview runs inside execution.

Review the dry-run plan, then repeat the same command with `--execute`. Cutover
transfers the existing `mail.apehost.dev` custom domain and captured mail routes,
then updates only the saved catch-all action. It retains the original catch-all
name/matchers and compares MX/TXT records and Email Sending onboarding with the
saved originals. It does not write DNS or sending-domain endpoints. The zone
already has two `_dmarc` TXT records with conflicting policies; this tool
preserves both unchanged.

Use the same flags with `rollback` before retirement, or `decommission` after
final acceptance; append `--execute` only after reviewing the plan. The runtime
receipt must postdate cutover for decommission. Queue metrics must show zero
backlog count/bytes and no oldest queued message. Cloudflare labels those metrics
best-effort, so the runtime receipt must separately attest that source producers,
in-flight work and retries have quiesced. No queue is purged.

Decommission removes source queue consumers, then the exact Mailflare Worker
with `force=false`, then queues only after consumers/producers are absent.
Decommission requires exact current-source equality with the final snapshot:
every captured D1 table, the full D1 schema/row hash, the complete R2 inventory
and object bytes must match, with stable repeated reads. Unimported arrivals or
any derived-table change stop retirement before deletion. These strict checks
remain at the original retirement boundaries, together with independent target
parity, target drift detection, both verified backups and final runtime/queue
acceptance. Refresh/import/verify/back up the final delta after source quiescence.

Immediately before Worker deletion it rechecks complete ownership and all Hub
object cursors with `hasStoredData: false`. Both the Worker and its namespace
must then be absent before any queue, R2 or D1 retirement continues. A surviving
namespace stops the command, including after a lost response; the tool never
deletes a namespace directly or forces deletion. It checks
and deletes each backed-up source R2 object before deleting the empty source
bucket, rechecks full source D1 freshness before database deletion, and removes
only the saved obsolete rule ID. It preserves OmniMail resources, unrelated
rules, DNS, sending onboarding and both backup locations. It does not delete a
whole ruleset. Every mutation saves its intent before execution; repeating a
command verifies completed steps and resumes after a lost response. An object
or resource disappearing without a corresponding saved intent causes refusal.

If the process was forcibly terminated and left a `.lock` file, verify that no
cutover process is running before removing that exact lock to resume.

The final `audit` enumerates Mailflare Worker, D1, R2, queue, Durable Object namespace, custom-domain,
route, rule and Worker-binding leftovers. Account resources are checked across
the account; routes/rulesets/email routing are scoped to the named zone. Worker
route metadata also blocks retirement if Mailflare has routes in another zone.
Audit failure or remaining resources must be investigated before claiming full
replacement.

## Independent receipts

The parity receipt is generated by `verify-mailflare-import`, not the importer.
It must have schema `apehost-mail-parity/v1`, the configured account and exact
source/target identities, verifier version/revision, verification time, and
`parity.verified: true`. Every required check must be `PASSED`; optional deployment
checks may remain `UNVERIFIED`. Source message/attachment/object counts must
match the snapshot. `snapshot.manifestSha256` hashes exact snapshot file bytes;
`snapshot.objectsSha256` hashes `JSON.stringify` of objects projected to
`{key,size,sha256}`, sorted with `key.localeCompare(other.key, 'en')`.

The operator supplies a separate runtime receipt after Browser Harness and real
mail transport acceptance. This is evidence of checks already performed; setting
booleans without performing those checks is not verification.

```json
{
  "schema": "apehost-mail-runtime/v1",
  "verifiedAt": "<ISO time after snapshot; after cutover for retirement>",
  "accountId": "7031244e5dbce80f897a55df4b7c859b",
  "zoneId": "e2c7c4a817c98ffccf4b3e964bd9aa13",
  "target": { "worker": "omni-mail", "databaseId": "<saved UUID>", "bucket": "omni-mail-storage" },
  "snapshot": { "manifestSha256": "<exact snapshot SHA-256>" },
  "checks": {
    "stageLogin": true, "privateInbox": true, "attachments": true,
    "nativeSend": true, "framing": true,
    "finalLogin": true, "finalInbound": true, "finalSend": true,
    "sourceQueuesQuiesced": true
  },
  "evidence": { "harness": "<artifact/session>", "mail": "<message IDs/artifacts>" }
}
```

Cutover/rollback require the first five checks. Decommission additionally
requires all final checks and queue quiescence. Receipts with another snapshot,
source, target, missing evidence or invalid timestamps cause a refusal. Refresh
the parity/runtime receipts and backup when refreshing the source snapshot.

Parity receipts also contain `targetState`: observed hashes/counts for full
imported `messages`, `attachments`, `message_search` and archived `settings`
rows, plus hashes of every copied raw object and generated body object. The tool
reads those imported rows and objects again before cutover and destructive
retirement, and immediately before deleting source D1. New live mail can coexist
with that imported subset. A changed imported row/object causes refusal. When
the independent verifier recorded a target deployment ID/version set, the tool
also rejects deployment changes until a new receipt is verified and backed up.
Rollback remains available if target data drifted, while source resources remain.

The console change is a separate PR against the explicitly approved
`feat/initial-shell` base, synchronized with `main` to preserve the current
floating-dock implementation and its session behavior. Check the shared deployed
revision again before activation so concurrent releases remain present.

## Validation

Cutover-tool checks are separate from application acceptance:

- `rtk node --test scripts/apehost-cutover.node-test.mjs scripts/apehost-email-rules.node-test.mjs scripts/apehost-baseline.node-test.mjs scripts/apehost-domain-transfer.node-test.mjs`
  covers dry runs, destructive
  refusal, receipt mismatches, source freshness, local/remote backup corruption,
  queue ownership/backlog, exact deletion scope, rollback and interrupted resume.
  It also covers complete Durable Object pagination, exact source-review
  boundaries, immutable Worker archives, fresh storage refusal, Worker/namespace
  absence after interrupted deletion, and sanitized malformed private JSON.
  Routing regressions cover the duplicate catch-all contract, identity/body
  mismatches, ordinary forwarding rules and 50-item page/count completion.
  Baseline regressions cover full schema/table coverage, live source growth
  before/during backup, unchanged imported mail/attachments/objects, captured
  artifact identity, reversible rollback and strict final-delta refusal.
  Domain regressions cover the real 409 attach contract, bidirectional transfer,
  unrelated domains, exact flags, preview conflicts, observable ownership races,
  failed/lost responses, resumed intents and dry runs.
- `rtk node scripts/check-file-lines.mjs` checks repository file size limits.
- No mocked test establishes live delivery or Browser Harness acceptance.

Earlier application validation for the prepared native-sending integration:

- `npm test`: 829 passing tests, including native sending, binary attachments,
  provider precedence, ambiguous failures and failure to record an accepted send.
- `npm run test:worker`: 67 passing tests in the real Worker runtime.
- `npm run build`: line limits, lint, three TypeScript checks and production build.
- All checked-in D1 migrations apply to a new local database.
- `node scripts/smoke-apehost.mjs`: a local Worker and Chromium verify trusted and
  untrusted framing, private inbox access, real browser sign-in and CSRF rejection.
  The production mail hostname is intercepted and forwarded to loopback; no live
  mailbox or real outbound transport is used.

To repeat the browser smoke, use local `.dev.vars` with `COOKIE_SECURE=false`,
`APP_ORIGINS=http://127.0.0.1:8942` and
`SETUP_TOKEN=local-smoke-only-setup-token-at-least-32-bytes`. Apply local migrations
and run `wrangler dev --local --ip 127.0.0.1 --port 8942`. The script creates a
local test owner on a fresh database. Local test passwords are never deployed.

Hono is patched to 4.13.13; the production dependency audit is clean. Upstream
development-tool dependency advisories remain. Public sign-in and real mail
delivery must be checked during activation; they are not claimed as verified here.
