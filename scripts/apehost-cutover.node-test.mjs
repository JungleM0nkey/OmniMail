import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SITE, sha256, readSnapshot, validateReceipts, objectPath, runCutover, oauthApi } from './apehost-cutover.mjs'

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
    tables: { messages: [{ id: 'message-1', subject: 'private' }], message_attachments: [{ id: 'att-1', message_id: 'message-1' }], mailboxes: [{ id: 'owner' }], domains: [{ id: 'domain-1', name: 'apehost.dev' }], api_keys: [{ id: 'must-also-back-up' }], contacts: [{ id: 'contact-1', seen: 1 }] },
    objects: [object('raw/msg 1.eml', 'Subject: private\r\n\r\nhello'), object('attachments/att-1', 'attachment')] }
  data.schema = Object.keys(data.tables).sort().map((name) => ({ type: 'table', name, tbl_name: name, sql: `CREATE TABLE ${name} (...)` }))
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
  const tables = copy(data.tables), schema = copy(data.schema)
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
  const storage = { namespaces: [], pages: [{ result: [], result_info: { cursor: '' } }], keepNamespace: false,
    download: { bytes: Buffer.from('reviewed-worker-fixture'), contentType: 'multipart/form-data; boundary=fixture', etag: `"${review.etag}"` } }
  const envelope = (result, result_info) => ({ result: copy(result), ...(result_info ? { result_info } : {}) })
  const api = async (method, path, opts = {}) => {
    calls.push({ method, path, body: opts.body })
    const url = new URL(`https://api.cloudflare.com${path}`), p = url.pathname
    const override = await storage.intercept?.({ method, path, p, url, opts })
    if (override !== undefined) return override
    const isRead = method === 'GET' || method === 'POST' && (p.endsWith('/domains/changeset')
      || p.endsWith('/query') && (opts.body.sql?.startsWith('SELECT ') || opts.body.batch?.every((q) => q.sql.startsWith('SELECT '))))
    if (!isRead) mutations.push({ method, path, body: opts.body })
    let result
    if (method === 'GET') {
      if (p === `${A}/workers/durable_objects/namespaces`) {
        const page = Number(url.searchParams.get('page')), per_page = Number(url.searchParams.get('per_page'))
        assert.ok(page >= 1 && per_page >= 1 && per_page <= 1000)
        const result = storage.namespaces.slice((page - 1) * per_page, page * per_page)
        return envelope(result, { page, per_page, count: result.length, total_count: storage.namespaces.length })
      }
      if (p === `${A}/workers/durable_objects/namespaces/${review.id}/objects`) {
        assert.equal(url.searchParams.get('limit'), '1000')
        const cursor = url.searchParams.get('cursor') ?? ''
        const index = cursor ? storage.pages.findIndex((page) => page.result_info?.cursor === cursor) + 1 : 0
        assert.ok(index >= 0 && storage.pages[index], 'Unexpected object cursor')
        return copy(storage.pages[index])
      }
      if (p === `${A}/workers/scripts/${SITE.source}`) {
        assert.equal(opts.binary, true); assert.equal(opts.responseMetadata, true)
        return { ...storage.download, bytes: Buffer.from(storage.download.bytes) }
      }
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
    } else if (method === 'POST' && p.endsWith('/domains/changeset')) {
      assert.equal(url.searchParams.get('replace_state'), 'false')
      return envelope({ added: [], removed: [], conflicting: [], affected_zones: [SITE.zone],
        updated: [{ ...view.domains.find((d) => d.hostname === opts.body[0].hostname), ...opts.body[0], service: p.split('/')[5], modified: true }] })
    } else if (method === 'POST' && p.endsWith('/query')) {
      if (opts.body.batch) return envelope((await Promise.all(opts.body.batch.map(({ sql }) => api('POST', path, { body: { sql } })))).flatMap((r) => r.result))
      const sql = opts.body.sql
      if (p === `${A}/d1/database/${targetDb}/query`) return envelope([{ success: true, results: targetTables[sql.match(/^SELECT \* FROM ([a-z_]+)/)[1]] }])
      if (sql.includes('sqlite_master')) return envelope([{ success: true, results: schema }])
      const name = sql.match(/FROM "([^"]+)"/)[1]
      return envelope([{ success: true, results: sql.includes('COUNT(*)') ? [{ n: tables[name].length }] : tables[name] }])
    } else if (method === 'PUT' && p === `${A}/workers/domains`) {
      throw new Error('HTTP 409 code 100116: account domain attach cannot transfer an existing hostname')
    } else if (method === 'PUT' && p.endsWith('/domains/records')) {
      assert.deepEqual([opts.body.override_scope, opts.body.override_existing_origin, opts.body.override_existing_dns_record], [false, true, false])
      Object.assign(view.domains.find((d) => d.hostname === opts.body.origins[0].hostname), opts.body.origins[0], { service: p.split('/')[5] }); result = envelope({})
    } else if (method === 'PUT' && p.startsWith(`${Z}/workers/routes/`)) {
      Object.assign(view.routes.find((r) => r.id === p.split('/').at(-1)), opts.body); result = envelope({})
    } else if (method === 'PUT' && p.endsWith('/catch_all')) { Object.assign(view.catchAll, copy(opts.body)); result = envelope({})
    } else if (method === 'DELETE' && p.includes('/consumers/')) {
      const id = p.split('/')[4], consumer = p.split('/').at(-1), q = view.queues.find((q) => q.queue_id === id)
      q.consumers = q.consumers.filter((c) => c.consumer_id !== consumer); q.consumers_total_count = q.consumers.length; result = envelope({})
    } else if (method === 'DELETE' && p === `${A}/workers/scripts/${SITE.source}`) {
      assert.equal(url.searchParams.get('force'), 'false')
      view.workers = view.workers.filter((w) => w.id !== SITE.source); delete view.settings[SITE.source]
      if (!storage.keepNamespace) storage.namespaces = storage.namespaces.filter((n) => n.script !== SITE.source)
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
  return { api, run, ready, cutover, view, tables, schema, targetTables, buckets, calls, mutations, metrics, failAfter, options, data, snapshot, parity, runtime, storage }
}

const review = { id: '702f544aa78e480db6bb37f2aac86380', etag: '203f2efecc8d108bb8e7ea28c81068b06725d5f539dccd02c37e86f56194bd3c' }
function audited(f) {
  f.view.workers[0].etag = review.etag
  f.view.workers[0].named_handlers = [{ name: 't', handlers: ['fetch'] }, { name: 'RealtimeHub', handlers: ['class'] }]
  f.view.settings[SITE.source].bindings.push(
    { type: 'durable_object_namespace', name: 'REALTIME', class_name: 'RealtimeHub', namespace_id: review.id },
    { type: 'service', name: 'WORKER_SELF_REFERENCE', environment: 'production', service: SITE.source })
  f.view.settings[SITE.source].observability = { enabled: true }
  f.storage.namespaces = [{ id: review.id, name: 'mailflare_RealtimeHub', script: SITE.source, class: 'RealtimeHub', use_sqlite: true }]
  f.storage.pages = [{ result: [{ id: 'a'.repeat(64), hasStoredData: false }], result_info: { cursor: 'next/+?' } }, { result: [], result_info: { cursor: '' } }]
  return f
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

test('baseline row and object changes prevent any reversible cutover mutation', async (t) => {
  const f = fixture(t); await f.ready(); let count = f.mutations.length
  f.tables.messages[0].subject = 'modified'
  await assert.rejects(f.run('cutover', true), /changed since snapshot/); assert.equal(f.mutations.length, count)
  f.tables.messages[0].subject = 'private'; f.tables.message_attachments[0].filename = 'modified'
  await assert.rejects(f.run('cutover', true), /changed since snapshot/); assert.equal(f.mutations.length, count)
  delete f.tables.message_attachments[0].filename; f.buckets.get(SITE.bucket).set('raw/msg 1.eml', Buffer.from('edited'))
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
  const f = fixture(t); await f.ready(); f.failAfter.add(`${A}/workers/scripts/${SITE.target}/domains/records`)
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

test('malformed private JSON never exposes credential or snapshot bytes', (t) => {
  const f = fixture(t), marker = 'PRIVATE_FIXTURE_SECRET'
  const safe = (error) => error.message === 'Private JSON input is invalid.' && !error.stack.includes(marker)
  writeFileSync(f.options.snapshot, marker)
  assert.throws(() => readSnapshot(f.options.snapshot), safe)
  writeFileSync(f.options.snapshot, '\uFEFF' + JSON.stringify(f.data))
  assert.deepEqual(readSnapshot(f.options.snapshot).data, f.data)
  const home = join(f.options.state, '..', 'malformed-home'); mkdirSync(join(home, '.cloudflare-oauth'), { recursive: true })
  writeFileSync(join(home, '.cloudflare-oauth', 'tokens.json'), marker)
  assert.throws(() => oauthApi({ home, spawn: () => ({ status: 0 }) }), safe)
})

test('OAuth binary metadata is opt-in and preserves raw Worker headers without changing R2 reads', async (t) => {
  const f = fixture(t), home = join(f.options.state, '..', 'binary-home')
  mkdirSync(join(home, '.cloudflare-oauth'), { recursive: true })
  json(join(home, '.cloudflare-oauth', 'tokens.json'), { access_token: 'fixture-only' })
  const bytes = Buffer.from([0, 255, 3, 13, 10]), headers = { 'Content-Type': 'multipart/form-data; boundary=test', ETag: `"${review.etag}"` }
  const api = oauthApi({ home, spawn: () => ({ status: 0 }), fetcher: async () => new Response(bytes, { headers }) })
  assert.deepEqual(await api('GET', objectPath(SITE.bucket, 'raw/test'), { binary: true }), bytes)
  assert.deepEqual(await api('GET', `${A}/workers/scripts/${SITE.source}`, { binary: true, responseMetadata: true }),
    { bytes, contentType: headers['Content-Type'], etag: headers.ETag })
})

test('reviewed empty Hub archives original bytes, headers, full settings and cursor proof once', async (t) => {
  const f = audited(fixture(t))
  const status = await f.run('audit')
  assert.deepEqual(status.leftovers.durableObjects.map((n) => n.id), [review.id])
  await f.run('prepare'); assert.equal(existsSync(`${f.options.state}.source-worker.json`), false)
  assert.equal(f.mutations.length, 0)
  f.calls.length = 0
  await f.ready()
  const state = JSON.parse(readFileSync(f.options.state)), bytes = readFileSync(state.sourceArchive.path), archive = JSON.parse(bytes)
  assert.equal(sha256(bytes), state.sourceArchive.sha256)
  assert.equal(Buffer.from(archive.worker.bodyBase64, 'base64').toString(), f.storage.download.bytes.toString())
  assert.equal(archive.worker.contentType, f.storage.download.contentType)
  assert.deepEqual(archive.settings, f.view.settings[SITE.source]); assert.equal(archive.empty.pages.length, 2)
  assert.equal(archive.empty.pages.at(-1).result_info.cursor, '')
  assert.equal(state.backup.artifacts['source-worker.json'], state.sourceArchive.sha256)
  await f.run('prepare', true); await f.run('backup', true)
  assert.equal(f.calls.filter((c) => c.path === `${A}/workers/scripts/${SITE.source}`).length, 1)
  assert.deepEqual(readFileSync(state.sourceArchive.path), bytes)
})

test('complete namespace catalog finds the source beyond the first 1000 records', async (t) => {
  const f = audited(fixture(t)), source = f.storage.namespaces[0]
  f.storage.namespaces = [...Array.from({ length: 1000 }, (_, i) => ({ id: (i + 1).toString(16).padStart(32, '0'), name: `other_${i}`, script: 'other', class: 'Other', use_sqlite: true })), source]
  const result = await f.run('status')
  assert.deepEqual(result.leftovers.durableObjects.map((n) => n.id), [review.id])
  assert.ok(f.calls.some((c) => c.path.includes('/durable_objects/namespaces?') && c.path.includes('page=2')))
  await f.run('prepare', true)
})

test('uncertain namespace catalog pagination refuses incomplete retirement inventory', async (t) => {
  for (const result_info of [{ page: 1, per_page: 1000, count: 1 }, { page: 1, per_page: 1000, count: 0, total_count: 1 }, { page: 2, per_page: 1000, count: 1, total_count: 1 }]) {
    const f = audited(fixture(t))
    f.storage.intercept = ({ p }) => p.endsWith('/durable_objects/namespaces') ? { result: copy(f.storage.namespaces), result_info } : undefined
    await assert.rejects(f.run('prepare', true), /namespace catalog/i)
    assert.equal(f.mutations.length, 0)
  }
})

test('namespace catalog refuses duplicate identities and changing totals across pages', async (t) => {
  for (const duplicate of [true, false]) {
    const f = audited(fixture(t)), source = f.storage.namespaces[0]
    f.storage.namespaces = [...Array.from({ length: 1000 }, (_, i) => ({ ...source, id: (i + 1).toString(16).padStart(32, '0'), script: 'other', name: `other_${i}` })), source]
    f.storage.intercept = ({ p, url }) => p.endsWith('/durable_objects/namespaces') && url.searchParams.get('page') === '2'
      ? { result: [duplicate ? f.storage.namespaces[0] : source], result_info: { page: 2, per_page: 1000, count: 1, total_count: duplicate ? 1001 : 1002 } } : undefined
    await assert.rejects(f.run('prepare', true), /namespace catalog/i)
    assert.equal(f.mutations.length, 0)
  }
})

test('object pagination follows short pages and refuses stored, missing flags, invalid or repeated cursors', async (t) => {
  for (const page of [
    { result: [{ id: 'b'.repeat(64), hasStoredData: true }], result_info: { cursor: '' } },
    { result: [{ id: 'b'.repeat(64) }], result_info: { cursor: '' } },
    { result: [{ id: 'b'.repeat(64), hasStoredData: null }], result_info: { cursor: '' } },
    { result: [{ id: 'a'.repeat(64), hasStoredData: false }], result_info: { cursor: '' } },
    { result: [], result_info: { cursor: 'next/+?' } }, { result: [], result_info: { cursor: 3 } },
    { result: [], result_info: {} },
  ]) {
    const f = audited(fixture(t)); f.storage.pages[1] = page
    await assert.rejects(f.run('prepare', true), /Durable Object|object cursor/i)
    assert.equal(existsSync(f.options.state), false); assert.equal(f.mutations.length, 0)
  }
})

test('Hub exception rejects changed ETag, extra namespaces/classes, foreign refs and altered self-reference', async (t) => {
  for (const change of [
    (f) => { f.view.workers[0].etag = 'unreviewed-code' },
    (f) => { f.storage.download.etag = 'unreviewed-download' },
    (f) => { f.storage.download.contentType = 'application/javascript' },
    (f) => { f.storage.namespaces.push({ ...f.storage.namespaces[0], id: 'f'.repeat(32), class: 'Unknown' }) },
    (f) => { f.view.workers[0].named_handlers.push({ name: 'Unknown', handlers: ['class'] }) },
    (f) => { f.view.workers[0].named_handlers.pop() },
    (f) => { f.view.settings[SITE.source].bindings.find((b) => b.name === 'REALTIME').class_name = 'Other' },
    (f) => { f.view.settings[SITE.source].bindings.at(-1).environment = 'preview' },
    (f) => { f.view.settings[SITE.target].bindings.push({ type: 'durable_object_namespace', name: 'FOREIGN', namespace_id: review.id, class_name: 'RealtimeHub' }) },
    (f) => { f.view.settings[SITE.target].bindings.push({ type: 'durable_object_namespace', name: 'FOREIGN', script_name: SITE.source, class_name: 'RealtimeHub' }) },
  ]) {
    const f = audited(fixture(t)); change(f)
    await assert.rejects(f.run('prepare', true), /review|Durable Object|Mailflare reference|Worker archive/i)
    assert.equal(f.mutations.length, 0)
  }
})

test('source archive corruption and missing independent copy block all cutover mutations', async (t) => {
  const f = audited(fixture(t)); await f.ready()
  const state = JSON.parse(readFileSync(f.options.state)), original = readFileSync(state.sourceArchive.path), count = f.mutations.length
  writeFileSync(state.sourceArchive.path, 'corrupt')
  await assert.rejects(f.run('cutover', true), /archive|backup verification/i)
  writeFileSync(state.sourceArchive.path, original)
  f.buckets.get(SITE.backupBucket).delete(`${state.backup.prefix}/source-worker.json`)
  await assert.rejects(f.run('cutover', true), /backup verification|R2 object absent/i)
  assert.equal(f.mutations.length, count)
})

test('a fresh stored object after queue drain blocks Worker and storage deletion', async (t) => {
  const f = audited(fixture(t)); await f.cutover()
  f.storage.intercept = ({ method, p }) => {
    if (method === 'DELETE' && p.includes('/consumers/') && f.view.queues.filter((q) => q.consumers.length).length === 1) {
      f.storage.pages[1].result = [{ id: 'b'.repeat(64), hasStoredData: true }]
    }
  }
  const count = f.mutations.length
  await assert.rejects(f.run('decommission', true), /Durable Object/i)
  assert.ok(f.view.settings[SITE.source]); assert.equal(f.buckets.get(SITE.bucket).size, 2)
  assert.ok(f.mutations.slice(count).every((c) => c.path.includes('/consumers/')))
})

test('surviving namespace blocks further retirement after successful or lost Worker response', async (t) => {
  for (const lost of [false, true]) {
    const f = audited(fixture(t)); await f.cutover(); f.storage.keepNamespace = true
    if (lost) f.failAfter.add(`${A}/workers/scripts/${SITE.source}`)
    const count = f.mutations.length
    await assert.rejects(f.run('decommission', true), /namespace|lost response/i)
    assert.equal(f.view.settings[SITE.source], undefined); assert.equal(f.view.queues.length, 3)
    assert.equal(f.view.databases.length, 2); assert.equal(f.buckets.get(SITE.bucket).size, 2)
    await assert.rejects(f.run('decommission', true), /namespace/i)
    assert.equal(f.mutations.slice(count).filter((c) => c.path.includes('/workers/scripts/')).length, 1)
    f.storage.namespaces = [] // A separately verified external recovery; the tool never deletes namespaces directly.
    assert.equal((await f.run('decommission', true)).phase, 'decommissioned')
  }
})

test('lost Worker response resumes only after both Worker and namespace absence, without repeat delete', async (t) => {
  const f = audited(fixture(t)); await f.cutover(); f.failAfter.add(`${A}/workers/scripts/${SITE.source}`)
  await assert.rejects(f.run('decommission', true), /lost response/)
  assert.equal(f.storage.namespaces.length, 0)
  assert.equal((await f.run('decommission', true)).phase, 'decommissioned')
  const deletes = f.calls.filter((c) => c.method === 'DELETE' && c.path.includes('/workers/scripts/'))
  assert.equal(deletes.length, 1); assert.ok(deletes[0].path.endsWith('?force=false'))
  const index = f.calls.indexOf(deletes[0])
  assert.ok(f.calls[index - 1].path.includes(`/namespaces/${review.id}/objects?`))
})

test('listed catch-all is validated separately and historical name does not remain an email reference', async (t) => {
  const f = fixture(t)
  Object.assign(f.view.catchAll, { tag: SITE.catchAll, name: 'Deliver apehost.dev mail to Mailflare', priority: 2147483647 })
  Object.defineProperty(f.view, 'emailRules', { get: () => { const listed = copy(f.view.catchAll); delete listed.priority; return [listed] } })
  await f.run('prepare'); assert.equal(existsSync(f.options.state), false); assert.equal(f.mutations.length, 0)
  await f.ready()
  const state = JSON.parse(readFileSync(f.options.state))
  assert.deepEqual(state.original.emailRules, []); assert.equal(state.original.catchAll.priority, 2147483647)
  assert.deepEqual((await f.run('audit')).leftovers.emailRules, [SITE.catchAll])
  await f.run('cutover', true)
  assert.deepEqual((await f.run('audit')).leftovers.emailRules, [])
  assert.equal(f.view.catchAll.name, 'Deliver apehost.dev mail to Mailflare')
  await f.run('rollback', true)
  assert.deepEqual((await f.run('audit')).leftovers.emailRules, [SITE.catchAll])
})

test('listed catch-all inconsistencies, unknown identities and ordinary source forwards still refuse', async (t) => {
  for (const change of [
    (listed) => { listed.name = 'changed' }, (listed) => { listed.enabled = false },
    (listed) => { listed.actions = [{ type: 'worker', value: [SITE.target] }] },
    (listed) => { listed.matchers = [{ type: 'literal', field: 'to', value: 'other@apehost.dev' }] },
    (listed) => { listed.source = 'other' }, (listed) => { listed.tag = 'conflicting-id' },
    (listed) => { delete listed.id; delete listed.tag }, (listed) => { listed.id = listed.tag = 'ordinary-source-forward' },
    (_listed, dedicated) => { dedicated.tag = 'conflicting-id' },
  ]) {
    const f = fixture(t), listed = copy(f.view.catchAll); change(listed, f.view.catchAll); f.view.emailRules = [listed]
    await assert.rejects(f.run('prepare', true), /identity|listed catch-all|route\/domain/i)
    assert.equal(f.mutations.length, 0); assert.equal(existsSync(f.options.state), false)
  }
})

test('captured baseline backup and reversible cutover allow new mail and derived changes, retirement refuses delta', async (t) => {
  const f = fixture(t); await f.run('prepare', true)
  f.tables.messages.push({ id: 'new-message' }); f.tables.message_attachments.push({ id: 'new-attachment', message_id: 'new-message' })
  f.tables.contacts[0].seen++; f.buckets.get(SITE.bucket).set('new/raw.eml', Buffer.from('new mail'))
  let duringCopy = false
  f.storage.intercept = ({ method, p }) => { if (!duringCopy && method === 'PUT' && p.includes('/r2/')) { duringCopy = true; f.tables.contacts[0].seen++ } }
  const count = f.mutations.length; await f.run('backup'); assert.equal(f.mutations.length, count)
  await f.run('backup', true)
  const state = JSON.parse(readFileSync(f.options.state)), archived = JSON.parse(readFileSync(join(state.backup.directory, 'source-d1.json')))
  assert.equal(state.backup.kind, 'captured-d1/v1'); assert.deepEqual(archived.schema, f.data.schema)
  assert.equal(archived.tables.messages.length, 1); assert.deepEqual(archived.tables.contacts, [JSON.stringify(f.data.tables.contacts[0])])
  f.tables.api_keys.push({ id: 'new-key' }); await f.run('cutover', true)
  const beforeDelete = f.mutations.length
  await assert.rejects(f.run('decommission', true), /changed since snapshot|D1 changed/)
  assert.equal(f.mutations.length, beforeDelete); assert.ok(f.view.settings[SITE.source]); assert.equal(f.buckets.get(SITE.bucket).size, 3)
  await f.run('rollback', true); assert.equal(f.tables.messages.length, 2); assert.equal(f.buckets.get(SITE.bucket).size, 3)
})

test('baseline deletion, attachment membership changes and full-schema drift block backup before writes', async (t) => {
  for (const change of [
    (f) => { f.tables.messages.pop() }, (f) => { f.tables.message_attachments.pop() },
    (f) => { f.tables.message_attachments.push({ id: 'late-attachment', message_id: 'message-1' }) },
    (f) => { f.schema[0].sql = 'changed schema' }, (f) => { f.buckets.get(SITE.bucket).delete('raw/msg 1.eml') },
  ]) {
    const f = fixture(t); await f.run('prepare', true); change(f); const count = f.mutations.length
    await assert.rejects(f.run('backup', true), /schema|changed|disappeared|attachment|R2/i)
    assert.equal(f.mutations.length, count); assert.equal(JSON.parse(readFileSync(f.options.state)).backup, undefined)
  }
})

test('baseline message changes during R2 observation block reversible cutover', async (t) => {
  const f = fixture(t); await f.ready(); const count = f.mutations.length
  f.storage.intercept = ({ method, p }) => {
    if (method === 'GET' && p.startsWith(`${A}/r2/buckets/${SITE.bucket}/objects/`)) f.tables.messages[0].subject = 'changed during object reads'
  }
  await assert.rejects(f.run('cutover', true), /changed since snapshot/)
  assert.equal(f.mutations.length, count)
})

test('schema changing while baseline artifacts upload leaves no verified backup state', async (t) => {
  const f = fixture(t); await f.run('prepare', true)
  f.storage.intercept = ({ method }) => { if (method === 'PUT') f.schema[0].sql = 'changed during copy' }
  await assert.rejects(f.run('backup', true), /schema/i)
  assert.equal(JSON.parse(readFileSync(f.options.state)).backup, undefined)
  assert.ok(!f.mutations.some((c) => c.path.includes('/workers/domains') || c.method === 'DELETE'))
})

test('complete schema definitions survive captured backup and exact fresh retirement still succeeds', async (t) => {
  const f = fixture(t)
  f.schema.push({ type: 'index', name: 'messages_idx', tbl_name: 'messages', sql: 'CREATE INDEX messages_idx ON messages(id)' },
    { type: 'trigger', name: 'messages_trigger', tbl_name: 'messages', sql: 'CREATE TRIGGER messages_trigger ...' },
    { type: 'view', name: 'message_view', tbl_name: 'message_view', sql: 'CREATE VIEW message_view AS SELECT * FROM messages' })
  f.schema.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`, 'en')); f.data.schema = copy(f.schema)
  json(f.options.snapshot, f.data); const captured = readSnapshot(f.options.snapshot)
  f.parity.snapshot.manifestSha256 = captured.hash; f.runtime.snapshot.manifestSha256 = captured.hash
  json(f.options['parity-receipt'], f.parity); json(f.options['runtime-receipt'], f.runtime)
  await f.cutover(); const state = JSON.parse(readFileSync(f.options.state))
  assert.deepEqual(JSON.parse(readFileSync(join(state.backup.directory, 'source-d1.json'))).schema, f.schema)
  assert.equal((await f.run('decommission', true)).phase, 'decommissioned')
})
