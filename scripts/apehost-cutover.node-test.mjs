import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SITE, sha256, readSnapshot, validateReceipts, objectPath, list, step, runCutover, oauthApi } from './apehost-cutover.mjs'

const A = `/accounts/${SITE.account}`, Z = `/zones/${SITE.zone}`
const targetDb = 'c9f2d452-6059-406c-9101-861db1819448'
const time = '2026-10-18T19:00:00.000Z'
const scratch = resolve(process.platform === 'win32' ? 'D:/omnimail-resume-20261018/tmp' : tmpdir())
mkdirSync(scratch, { recursive: true })
const copy = (value) => structuredClone(value)
const json = (path, value) => writeFileSync(path, JSON.stringify(value))

function fixture(t) {
  const directory = mkdtempSync(join(scratch, 'cutover-test-'))
  t.after(() => { assert.ok(directory.startsWith(`${scratch}\\`) || directory.startsWith(`${scratch}/`)); rmSync(directory, { recursive: true, force: true }) })
  const object = (key, text) => ({ key, size: Buffer.byteLength(text), sha256: sha256(text), base64: Buffer.from(text).toString('base64') })
  const data = { createdAt: '2026-10-18T18:00:00.000Z', account: SITE.account, database: SITE.database, bucket: SITE.bucket,
    tables: { messages: [{ id: 'message-1', subject: 'private' }], message_attachments: [{ id: 'att-1' }], mailboxes: [{ id: 'owner' }], domains: [{ name: 'apehost.dev' }] },
    objects: [object('raw/msg 1.eml', 'Subject: private\r\n\r\nhello'), object('attachments/att-1', 'attachment')] }
  const snapshotPath = join(directory, 'snapshot.json'); json(snapshotPath, data)
  const snapshot = readSnapshot(snapshotPath)
  const requiredChecks = ['snapshot-integrity', 'source-mapping', 'worker-bindings', 'framing-policy', 'anonymous-access-denied',
    'original-password-login', 'csrf-rejected', 'target-data-read', 'identity-and-mailboxes', 'all-imported-ids-and-counts',
    'storage-accounting', 'folders-and-pagination', 'body-search', 'owned-session-cleanup',
    ...data.objects.map((o) => `object.${sha256(o.key).slice(0, 12)}`),
    ...data.tables.messages.flatMap((m) => ['metadata', 'archived-metadata', 'body-and-storage', 'signed-in-api'].map((suffix) => `message.${sha256(m.id).slice(0, 12)}.${suffix}`))]
  const parity = { schema: 'apehost-mail-parity/v1', verifiedAt: time, verifier: { name: 'verify-mailflare-import', version: 1, revision: 'a'.repeat(40) }, accountId: SITE.account,
    source: { worker: SITE.source, databaseId: SITE.database, bucket: SITE.bucket }, target: { worker: SITE.target, databaseId: targetDb, bucket: SITE.targetBucket, base: 'https://omnimail.apehost.dev' },
    snapshot: { manifestSha256: snapshot.hash, objectsSha256: snapshot.objectsHash }, parity: { verified: true, checks: [...requiredChecks.map((id) => ({ id, required: true, status: 'PASSED' })), { id: 'deployment', required: false, status: 'UNVERIFIED' }],
      counts: { sourceMessages: 1, sourceAttachments: 1, sourceObjects: 2, targetMessages: 1, targetAttachments: 1, verifiedObjects: 2, verifiedBodies: 1, importedMessages: 1, importedAttachments: 1 } } }
  const runtime = { schema: 'apehost-mail-runtime/v1', verifiedAt: '2026-10-18T20:00:00.000Z', accountId: SITE.account, zoneId: SITE.zone,
    target: { worker: SITE.target, databaseId: targetDb, bucket: SITE.targetBucket }, snapshot: { manifestSha256: snapshot.hash },
    checks: Object.fromEntries(['stageLogin', 'privateInbox', 'attachments', 'nativeSend', 'framing', 'finalLogin', 'finalInbound', 'finalSend', 'sourceQueuesQuiesced'].map((k) => [k, true])), evidence: { harness: 'independent-session' } }
  const options = { state: join(directory, 'state.json'), snapshot: snapshotPath, 'parity-receipt': join(directory, 'parity.json'), 'runtime-receipt': join(directory, 'runtime.json') }
  json(options['parity-receipt'], parity); json(options['runtime-receipt'], runtime)
  const tables = copy({ ...data.tables, api_keys: [{ id: 'must-also-back-up' }] })
  const targetTables = { messages: [{ id: 'mfl_1', subject: 'private' }], attachments: [{ id: 'mfl_a_1', message_id: 'mfl_1' }],
    message_search: [{ content: 'private', message_id: 'mfl_1' }], settings: [{ key: `mailflare_import:${SITE.database}:message-1`, value: 'archived metadata' }] }
  const targetObjects = [...data.objects.map((o, i) => ({ ...o, key: `target/objects/${i}` })), object('target/bodies/one.json', '{"text":"hello"}')]
  parity.targetState = { tables: Object.entries(targetTables).map(([name, values]) => ({ name, rows: values.length, sha256: sha256(JSON.stringify(values)) })),
    objects: targetObjects.map(({ key, size, sha256 }) => ({ key, size, sha256 })) }
  parity.target.deployment = { id: 'target-deployment', versions: [{ id: 'target-version', percentage: 100 }] }
  json(options['parity-receipt'], parity)
  const view = {
    deployment: { id: 'target-deployment', versions: [{ version_id: 'target-version', percentage: 100 }] },
    workers: [{ id: SITE.source, tag: 'source-tag', etag: 'source-code' }, { id: SITE.target, tag: 'target-tag', etag: 'target-code' }],
    settings: { [SITE.source]: { bindings: [{ type: 'd1', name: 'DB', id: SITE.database }, { type: 'r2_bucket', name: 'RAW', bucket_name: SITE.bucket }] },
      [SITE.target]: { bindings: [{ type: 'd1', name: 'DB', id: targetDb }, { type: 'r2_bucket', name: 'MAIL_BUCKET', bucket_name: SITE.targetBucket }, { type: 'r2_bucket', name: 'BACKUP_BUCKET', bucket_name: SITE.backupBucket }] } },
    databases: [{ uuid: SITE.database, name: 'mailflare-db' }, { uuid: targetDb, name: 'omni-mail-db' }],
    buckets: [SITE.bucket, SITE.targetBucket, SITE.backupBucket].map((name) => ({ name, creation_date: '2026-01-01' })),
    queues: SITE.queues.map((name, i) => ({ queue_name: name, queue_id: String(i + 1).padStart(32, '0'), producers: [{ type: 'worker', script: SITE.source }], producers_total_count: 1,
      consumers: [{ type: 'worker', script_name: SITE.source, consumer_id: String(i + 4).padStart(32, '0') }], consumers_total_count: 1 })),
    domains: [{ id: SITE.domain, hostname: SITE.hostname, zone_id: SITE.zone, service: SITE.source, enabled: true, previews_enabled: false }, { id: 'stage-domain', hostname: SITE.stage, zone_id: SITE.zone, service: SITE.target }],
    routes: [{ id: 'source-route', pattern: `${SITE.hostname}/*`, script: SITE.source }],
    catchAll: { id: SITE.catchAll, name: 'Original catch-all', enabled: true, source: 'api', actions: [{ type: 'worker', value: [SITE.source] }], matchers: [{ type: 'all' }] },
    emailRules: [], sending: [{ tag: 'sending-domain', name: 'apehost.dev', enabled: true }],
    rulesets: [{ id: SITE.ruleset, rules: [{ id: SITE.rule, description: 'mailflare_console_embedding', expression: 'host eq mail.apehost.dev' }, { id: 'unrelated-rule', description: 'keep' }] }],
    dns: [{ id: 'mx', name: 'apehost.dev', type: 'MX', content: 'route.mx.cloudflare.net', priority: 1 },
      { id: 'dmarc-1', name: '_dmarc.apehost.dev', type: 'TXT', content: 'v=DMARC1; p=none' }, { id: 'dmarc-2', name: '_dmarc.apehost.dev', type: 'TXT', content: 'v=DMARC1; p=reject' }],
  }
  const buckets = new Map(view.buckets.map((b) => [b.name, new Map()]))
  for (const o of data.objects) buckets.get(SITE.bucket).set(o.key, Buffer.from(o.base64, 'base64'))
  for (const o of targetObjects) buckets.get(SITE.targetBucket).set(o.key, Buffer.from(o.base64, 'base64'))
  const calls = [], mutations = [], metrics = new Map(), failAfter = new Set()
  const envelope = (result, result_info) => ({ result: copy(result), ...(result_info ? { result_info } : {}) })
  const api = async (method, path, opts = {}) => {
    calls.push({ method, path, body: opts.body })
    const url = new URL(`https://api.cloudflare.com${path}`), p = url.pathname
    const isRead = method === 'GET' || method === 'POST' && p.endsWith('/query') && (opts.body.sql?.startsWith('SELECT ') || opts.body.batch?.every((q) => q.sql.startsWith('SELECT ')))
    if (!isRead) mutations.push({ method, path, body: opts.body })
    let result
    if (method === 'GET') {
      const paths = { [`${A}/workers/scripts`]: view.workers, [`${A}/d1/database`]: view.databases, [`${A}/queues`]: view.queues,
        [`${A}/workers/domains`]: view.domains, [`${Z}/workers/routes`]: view.routes, [`${Z}/rulesets`]: view.rulesets.map(({ id }) => ({ id })),
        [`${Z}/dns_records`]: view.dns, [`${Z}/email/routing/rules`]: view.emailRules, [`${Z}/email/sending/subdomains`]: view.sending, [`${Z}/email/routing/rules/catch_all`]: view.catchAll }
      if (Object.hasOwn(paths, p)) return envelope(paths[p])
      if (p === `${A}/r2/buckets`) return envelope({ buckets: view.buckets })
      if (p === `${A}/workers/scripts/${SITE.target}/deployments`) return envelope({ deployments: [view.deployment] })
      if (p.endsWith('/settings')) return envelope(view.settings[p.split('/').at(-2)])
      if (p.startsWith(`${Z}/rulesets/`)) return envelope(view.rulesets.find((s) => s.id === p.split('/').at(-1)))
      if (p.startsWith(`${A}/queues/`)) {
        const id = p.split('/')[4]
        return envelope(p.endsWith('/metrics') ? metrics.get(id) ?? { backlog_count: 0, backlog_bytes: 0, oldest_message_timestamp_ms: null } : view.queues.find((q) => q.queue_id === id))
      }
    }
    if (p.startsWith(`${A}/r2/buckets/`)) {
      const parts = p.split('/'), bucket = parts[5], key = parts.slice(7).map(decodeURIComponent).join('/')
      if (parts[6] === 'objects' && parts.length > 7) {
        const contents = buckets.get(bucket)
        if (method === 'GET') {
          if (!contents?.has(key) && opts.allow404) return null
          assert.ok(contents?.has(key), 'R2 object absent'); return Buffer.from(contents.get(key))
        }
        if (method === 'PUT') contents.set(key, Buffer.from(opts.body))
        else if (method === 'DELETE') contents.delete(key)
      } else if (method === 'GET') return envelope([...buckets.get(bucket)].map(([key, bytes]) => ({ key, size: bytes.length, etag: sha256(bytes) })), { is_truncated: false })
      else if (method === 'DELETE') { assert.equal(buckets.get(bucket).size, 0); buckets.delete(bucket); view.buckets = view.buckets.filter((b) => b.name !== bucket) }
      result = envelope({})
    } else if (method === 'POST' && p.endsWith('/query')) {
      if (opts.body.batch) return envelope((await Promise.all(opts.body.batch.map(({ sql }) => api('POST', path, { body: { sql } })))).flatMap((r) => r.result))
      const sql = opts.body.sql
      if (p === `${A}/d1/database/${targetDb}/query`) return envelope([{ success: true, results: targetTables[sql.match(/^SELECT \* FROM ([a-z_]+)/)[1]] }])
      if (sql.includes('sqlite_master')) return envelope([{ success: true, results: Object.keys(tables).map((name) => ({ type: 'table', name, tbl_name: name, sql: `CREATE TABLE ${name} (...)` })) }])
      const name = sql.match(/FROM "([^"]+)"/)[1]
      return envelope([{ success: true, results: sql.includes('COUNT(*)') ? [{ n: tables[name].length }] : tables[name] }])
    } else if (method === 'PUT' && p === `${A}/workers/domains`) {
      Object.assign(view.domains.find((d) => d.hostname === opts.body.hostname), opts.body); result = envelope({})
    } else if (method === 'PUT' && p.startsWith(`${Z}/workers/routes/`)) {
      Object.assign(view.routes.find((r) => r.id === p.split('/').at(-1)), opts.body); result = envelope({})
    } else if (method === 'PUT' && p.endsWith('/catch_all')) { Object.assign(view.catchAll, copy(opts.body)); result = envelope({})
    } else if (method === 'DELETE' && p.includes('/consumers/')) {
      const id = p.split('/')[4], consumer = p.split('/').at(-1), q = view.queues.find((q) => q.queue_id === id)
      q.consumers = q.consumers.filter((c) => c.consumer_id !== consumer); q.consumers_total_count = q.consumers.length; result = envelope({})
    } else if (method === 'DELETE' && p === `${A}/workers/scripts/${SITE.source}`) {
      view.workers = view.workers.filter((w) => w.id !== SITE.source); delete view.settings[SITE.source]
      for (const q of view.queues) { q.producers = []; q.producers_total_count = 0 } result = envelope({})
    } else if (method === 'DELETE' && p.startsWith(`${A}/queues/`)) { view.queues = view.queues.filter((q) => q.queue_id !== p.split('/').at(-1)); result = envelope({})
    } else if (method === 'DELETE' && p === `${A}/d1/database/${SITE.database}`) { view.databases = view.databases.filter((d) => d.uuid !== SITE.database); result = envelope({})
    } else if (method === 'DELETE' && p.endsWith(`/rules/${SITE.rule}`)) { view.rulesets[0].rules = view.rulesets[0].rules.filter((r) => r.id !== SITE.rule); result = envelope({}) }
    else throw new Error(`Unexpected mock call ${method} ${p}`)
    if (failAfter.has(p)) { failAfter.delete(p); throw new Error('simulated lost response') }
    return result
  }
  const run = (command, execute = false) => runCutover(command, { ...options, execute }, { api, now: () => '2026-10-18T20:00:00.000Z' })
  const ready = async () => { await run('prepare', true); await run('backup', true) }
  const cutover = async () => { await ready(); await run('cutover', true) }
  return { api, run, ready, cutover, view, tables, targetTables, buckets, calls, mutations, metrics, failAfter, options, data, snapshot, parity, runtime }
}

test('status/audit and default preparation never mutate or save mail', async (t) => {
  const f = fixture(t)
  const status = await f.run('status', true), audit = await f.run('audit', true)
  assert.equal(status.readOnly, true); assert.deepEqual(audit.leftovers.workers, [SITE.source])
  assert.equal(audit.leftovers.rules.length, 1)
  await f.run('prepare')
  assert.equal(existsSync(f.options.state), false); assert.equal(f.mutations.length, 0)
})

test('parity receipts reject failed migration, mismatched identities/hashes and stale timestamps', (t) => {
  const f = fixture(t)
  assert.doesNotThrow(() => validateReceipts(f.snapshot, f.parity, f.runtime, targetDb, 'decommission', Date.parse(time) + 4_000_000, time))
  for (const change of [
    (r) => { r.parity.verified = false }, (r) => { r.parity.checks[0].status = 'UNVERIFIED' },
    (r) => { r.source.databaseId = targetDb }, (r) => { r.target.bucket = SITE.bucket },
    (r) => { r.snapshot.manifestSha256 = '0'.repeat(64) }, (r) => { r.snapshot.objectsSha256 = '0'.repeat(64) },
    (r) => { r.verifiedAt = '2020-01-01' }, (r) => { r.parity.counts.sourceMessages = 0 }, (r) => { r.parity.checks.splice(0, 1) },
  ]) { const receipt = copy(f.parity); change(receipt); assert.throws(() => validateReceipts(f.snapshot, receipt, f.runtime, targetDb, 'backup'), /receipt|parity|Migration/i) }
  assert.throws(() => validateReceipts(f.snapshot, f.parity, undefined, targetDb, 'cutover'), /runtime receipt/)
  const runtime = copy(f.runtime); runtime.checks.finalInbound = false
  assert.throws(() => validateReceipts(f.snapshot, f.parity, runtime, targetDb, 'decommission'), /unverified/)
})

test('all default dry runs preserve resources and write no Cloudflare changes', async (t) => {
  const f = fixture(t); await f.ready()
  let count = f.mutations.length
  await f.run('backup'); await f.run('cutover'); await f.run('rollback')
  assert.equal(f.mutations.length, count)
  await f.run('cutover', true); count = f.mutations.length
  assert.ok((await f.run('decommission')).plans.includes('delete-database'))
  assert.equal(f.mutations.length, count); assert.ok(f.view.settings[SITE.source]); assert.equal(f.buckets.get(SITE.bucket).size, 2)
})

test('source changes and incomplete backups prevent any cutover mutation', async (t) => {
  const f = fixture(t); await f.ready(); let count = f.mutations.length
  f.tables.messages.push({ id: 'new-message' })
  await assert.rejects(f.run('cutover', true), /changed since snapshot/); assert.equal(f.mutations.length, count)
  f.tables.messages.pop(); f.tables.api_keys.push({ id: 'new-key' })
  await assert.rejects(f.run('cutover', true), /D1 changed/); assert.equal(f.mutations.length, count)
  f.tables.api_keys.pop(); f.buckets.get(SITE.bucket).set('raw/msg 1.eml', Buffer.from('edited'))
  await assert.rejects(f.run('cutover', true), /R2 bytes/); assert.equal(f.mutations.length, count)
})

test('backup hashes are verified independently, and local + remote copies are mandatory', async (t) => {
  const f = fixture(t); await f.ready(); const state = JSON.parse(readFileSync(f.options.state))
  assert.ok(JSON.parse(readFileSync(join(state.backup.directory, 'source-d1.json'))).tables.api_keys)
  const remote = f.buckets.get(SITE.backupBucket), key = `${state.backup.prefix}/snapshot.json`
  remote.set(key, Buffer.from('corrupt'))
  await assert.rejects(f.run('cutover', true), /backup verification/)
  remote.set(key, f.snapshot.bytes); writeFileSync(join(state.backup.directory, 'snapshot.json'), 'corrupt')
  await assert.rejects(f.run('cutover', true), /backup verification/)
})

test('renewed parity for the same source snapshot gets a new immutable backup', async (t) => {
  const f = fixture(t); await f.ready()
  const old = JSON.parse(readFileSync(f.options.state)).backup
  f.parity.verifiedAt = '2026-10-18T19:01:00.000Z'; json(f.options['parity-receipt'], f.parity)
  await f.run('backup', true)
  const current = JSON.parse(readFileSync(f.options.state)).backup
  assert.equal(current.snapshotSha256, old.snapshotSha256); assert.notEqual(current.prefix, old.prefix)
  assert.ok(existsSync(join(old.directory, 'parity.json'))); assert.ok(existsSync(join(current.directory, 'parity.json')))
  await f.run('cutover', true)
})

test('target data, object and deployment drift refuse retirement while rollback stays available', async (t) => {
  const f = fixture(t); await f.cutover(); const count = f.mutations.length
  const row = f.targetTables.messages.pop()
  await assert.rejects(f.run('decommission', true), /Target messages drifted/); f.targetTables.messages.push(row)
  const bucket = f.buckets.get(SITE.targetBucket), key = f.parity.targetState.objects[0].key, bytes = bucket.get(key)
  bucket.set(key, Buffer.from('modified'))
  await assert.rejects(f.run('decommission', true), /Target object drifted/); bucket.set(key, bytes)
  f.view.deployment.id = 'new-unverified-deployment'
  await assert.rejects(f.run('decommission', true), /Target deployment changed/)
  assert.equal(f.mutations.length, count); await f.run('rollback', true)
  assert.ok(f.view.settings[SITE.source]); assert.equal(f.view.databases.length, 2)
})

test('cutover resumes a lost response and rollback preserves both storage sets', async (t) => {
  const f = fixture(t); await f.ready(); f.failAfter.add(`${A}/workers/domains`)
  await assert.rejects(f.run('cutover', true), /lost response/)
  await f.run('cutover', true); const count = f.mutations.length
  await f.run('cutover', true); assert.equal(f.mutations.length, count)
  assert.equal(f.view.catchAll.actions[0].value[0], SITE.target)
  await f.run('rollback', true)
  assert.equal(f.view.domains[0].service, SITE.source); assert.equal(f.view.catchAll.actions[0].value[0], SITE.source)
  assert.equal(f.view.databases.length, 2); assert.equal(f.buckets.size, 3)
  assert.ok(!f.mutations.some((c) => c.method === 'DELETE'))
})

test('decommission refuses missing parity, changed ownership, nonempty queues and changed DNS', async (t) => {
  const f = fixture(t); await f.cutover(); const count = f.mutations.length
  f.view.queues[0].producers.push({ type: 'worker', script: 'unrelated' }); f.view.queues[0].producers_total_count++
  await assert.rejects(f.run('decommission', true), /queue owner/)
  f.view.queues[0].producers.pop(); f.view.queues[0].producers_total_count--
  f.metrics.set(f.view.queues[0].queue_id, { backlog_count: 1, backlog_bytes: 1, oldest_message_timestamp_ms: 10 })
  await assert.rejects(f.run('decommission', true), /queue is not/); f.metrics.clear()
  f.view.dns[1].content = 'v=DMARC1; p=quarantine'
  await assert.rejects(f.run('decommission', true), /MX\/TXT/); f.view.dns[1].content = 'v=DMARC1; p=none'
  const parity = copy(f.parity); parity.parity.verified = false; json(f.options['parity-receipt'], parity)
  await assert.rejects(f.run('decommission', true), /Migration parity/)
  assert.equal(f.mutations.length, count)
})

test('decommission drains references, deletes only exact source resources and safely resumes partial object deletion', async (t) => {
  const f = fixture(t); await f.cutover(); const dns = copy(f.view.dns), sending = copy(f.view.sending)
  f.failAfter.add(new URL(`https://api.cloudflare.com${objectPath(SITE.bucket, f.data.objects[0].key)}`).pathname)
  await assert.rejects(f.run('decommission', true), /lost response/)
  assert.ok(!f.view.settings[SITE.source]); assert.equal(f.buckets.get(SITE.bucket).size, 1)
  const result = await f.run('decommission', true)
  assert.equal(result.phase, 'decommissioned'); assert.deepEqual(result.leftovers.workers, [])
  assert.deepEqual(result.leftovers.databases, []); assert.deepEqual(result.leftovers.buckets, []); assert.deepEqual(result.leftovers.queues, [])
  assert.equal(f.view.databases[0].uuid, targetDb); assert.equal(f.buckets.size, 2); assert.ok(f.buckets.get(SITE.backupBucket).size >= 4)
  assert.equal(f.view.rulesets[0].rules[0].id, 'unrelated-rule'); assert.deepEqual(f.view.dns, dns); assert.deepEqual(f.view.sending, sending)
  assert.ok(!f.mutations.some((c) => /dns_records|email\/sending/.test(c.path)))
  const workerDeletion = f.mutations.findIndex((c) => c.method === 'DELETE' && c.path.includes('/workers/scripts/'))
  assert.ok(f.mutations.slice(0, workerDeletion).filter((c) => c.path.includes('/consumers/')).length === 3)
  const count = f.mutations.length; await f.run('decommission', true); assert.equal(f.mutations.length, count)
  await assert.rejects(f.run('rollback', true), /retirement|disappeared/)
})

test('destructive resume rejects an unexpectedly missing object and a recreated queue', async (t) => {
  const f = fixture(t); await f.cutover(); const count = f.mutations.length
  f.buckets.get(SITE.bucket).delete(f.data.objects[0].key)
  await assert.rejects(f.run('decommission', true), /inventory changed|disappeared/)
  f.buckets.get(SITE.bucket).set(f.data.objects[0].key, Buffer.from(f.data.objects[0].base64, 'base64'))
  f.view.queues[0].queue_id = 'f'.repeat(32)
  await assert.rejects(f.run('decommission', true), /queue identity changed/)
  assert.equal(f.mutations.length, count)
})

test('resource recreation, unexpected storage/queue references and Durable Objects are refused', async (t) => {
  const f = fixture(t); await f.ready(); const count = f.mutations.length
  f.view.workers[0].tag = 'recreated-worker'
  await assert.rejects(f.run('cutover', true), /identity\/content/); f.view.workers[0].tag = 'source-tag'
  f.view.buckets[0].creation_date = 'new-bucket'
  await assert.rejects(f.run('cutover', true), /bucket identity/); f.view.buckets[0].creation_date = '2026-01-01'
  f.view.settings[SITE.source].bindings.push({ type: 'r2_bucket', bucket_name: 'unrelated-storage' })
  await assert.rejects(f.run('cutover', true), /ownership/); f.view.settings[SITE.source].bindings.pop()
  f.view.workers[0].exports = { State: { type: 'durable-object' } }
  await assert.rejects(f.run('cutover', true), /Durable Objects/); delete f.view.workers[0].exports
  f.view.queues.push({ queue_id: 'f'.repeat(32), queue_name: 'unrelated', producers: [{ type: 'worker', script: SITE.source }], consumers: [] })
  await assert.rejects(f.run('cutover', true), /unexpected queue/)
  assert.equal(f.mutations.length, count)
})

test('repeating a completed cutover retains the original acceptance timestamp', async (t) => {
  const f = fixture(t); await f.cutover()
  const before = JSON.parse(readFileSync(f.options.state)).cutoverAt
  await runCutover('cutover', { ...f.options, execute: true }, { api: f.api, now: () => '2026-10-18T20:05:00.000Z' })
  assert.equal(JSON.parse(readFileSync(f.options.state)).cutoverAt, before)
})

test('pagination consumes cursors and refuses loops/truncation', async () => {
  const calls = []
  const api = async (_m, path) => { calls.push(path); return path.includes('cursor=next') ? { result: [{ key: 'b' }], result_info: { is_truncated: false } } : { result: [{ key: 'a' }], result_info: { cursor: 'next', is_truncated: true } } }
  assert.equal((await list(api, `${A}/r2/buckets/${SITE.bucket}/objects`)).length, 2); assert.equal(calls.length, 2)
  await assert.rejects(list(async () => ({ result: [], result_info: { is_truncated: true } }), '/objects'), /no cursor/)
  await assert.rejects(list(async () => ({ result: [], result_info: { is_truncated: true, cursor: 'repeat' } }), '/objects'), /Repeated/)
})

test('ruleset inventory obeys its 50-item limit and follows after cursors', async () => {
  const calls = []
  const api = async (method, path) => {
    const url = new URL(`https://api.cloudflare.com${path}`)
    if (Number(url.searchParams.get('per_page')) > 50) throw new Error('HTTP 400: per_page cannot be greater than 50')
    assert.equal(method, 'GET'); assert.equal(url.pathname, `${Z}/rulesets`)
    assert.equal(url.searchParams.get('per_page'), '50'); assert.equal(url.searchParams.has('page'), false)
    calls.push(url.searchParams.get('cursor'))
    return url.searchParams.get('cursor') === 'next+/='
      ? { result: [{ id: 'last-rule' }], result_info: { cursors: { after: '' } } }
      : { result: Array.from({ length: 50 }, (_, i) => ({ id: `rule-${i}` })), result_info: { cursors: { after: 'next+/=' } } }
  }
  const result = await list(api, `${Z}/rulesets`)
  assert.equal(result.length, 51); assert.equal(result.at(-1).id, 'last-rule')
  assert.deepEqual(calls, [null, 'next+/='])
})

test('ruleset pagination honors short pages and refuses repeated after cursors', async () => {
  const api = async (_method, path) => new URL(`https://api.cloudflare.com${path}`).searchParams.has('cursor')
    ? { result: [{ id: 'second' }], result_info: { cursors: {} } }
    : { result: [{ id: 'first' }], result_info: { cursors: { after: 'next' } } }
  assert.deepEqual(await list(api, `${Z}/rulesets`), [{ id: 'first' }, { id: 'second' }])
  await assert.rejects(list(async () => ({ result: [], result_info: { cursors: { after: 'repeat' } } }), `${Z}/rulesets`), /Repeated/)
})

test('queue pages and R2 bucket cursors retain their existing 100-item requests', async () => {
  const pages = []
  const queues = await list(async (_method, path) => {
    const query = new URL(`https://api.cloudflare.com${path}`).searchParams
    assert.equal(query.get('per_page'), '100'); assert.equal(query.has('cursor'), false)
    const page = Number(query.get('page')); pages.push(page)
    return { result: [{ queue_id: `queue-${page}` }], result_info: { total_pages: 2 } }
  }, `${A}/queues`)
  assert.deepEqual(queues.map((q) => q.queue_id), ['queue-1', 'queue-2']); assert.deepEqual(pages, [1, 2])
  const buckets = await list(async (_method, path) => {
    const query = new URL(`https://api.cloudflare.com${path}`).searchParams
    assert.equal(query.get('per_page'), '100')
    return query.has('cursor') ? { result: { buckets: [{ name: 'last' }] }, result_info: {} }
      : { result: { buckets: [{ name: 'first' }] }, result_info: { cursor: 'bucket-next' } }
  }, `${A}/r2/buckets`, 'buckets')
  assert.deepEqual(buckets.map((b) => b.name), ['first', 'last'])
})

test('step records intent before a mutation and skips an already completed operation', async () => {
  const state = { started: {}, completed: {} }, saved = [], plans = []; let present = false, writes = 0
  const options = { execute: true, saveState: () => saved.push(copy(state)), plans, apply: async () => { assert.equal(saved.at(-1).started.one, true); writes++; present = true }, done: async () => present }
  await step(state, 'one', options); await step(state, 'one', options)
  assert.equal(writes, 1); assert.equal(state.completed.one, true)
})

test('snapshot validation rejects corrupt bytes, duplicate keys and unsafe R2 paths', (t) => {
  const f = fixture(t), altered = copy(f.data); altered.objects[0].base64 = 'Zm9yZ2Vk'
  json(f.options.snapshot, altered); assert.throws(() => readSnapshot(f.options.snapshot), /bytes\/hash/)
  altered.objects = [f.data.objects[0], f.data.objects[0]]; json(f.options.snapshot, altered)
  assert.throws(() => readSnapshot(f.options.snapshot), /Duplicate/)
  assert.throws(() => objectPath(SITE.bucket, '../danger'), /Unsafe/)
  assert.ok(objectPath(SITE.bucket, 'raw/a b.eml').endsWith('/raw/a%20b.eml'))
})

test('OAuth API refuses a failed helper and never sends credentials to redirects', async (t) => {
  const f = fixture(t)
  assert.throws(() => oauthApi({ spawn: () => ({ status: 1 }) }), /OAuth helper/)
  const home = join(f.options.state, '..', 'oauth-home'); mkdirSync(join(home, '.cloudflare-oauth'), { recursive: true })
  writeFileSync(join(home, '.cloudflare-oauth', 'tokens.json'), '\uFEFF' + JSON.stringify({ access_token: 'test-only-credential' }))
  let request
  const api = oauthApi({ home, spawn: () => ({ status: 0 }), fetcher: async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ success: true, result: [] }) } } })
  await api('GET', `${A}/queues`)
  assert.equal(request.options.redirect, 'error'); assert.equal(request.url, `https://api.cloudflare.com/client/v4${A}/queues`)
  await assert.rejects(api('GET', '/accounts/another/queues'), /Unexpected Cloudflare scope/)
})
