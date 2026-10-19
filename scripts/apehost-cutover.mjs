import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { REALTIME_REVIEW, namespaceCatalog, checkSourceStorage, emptyNamespace, prepareSourceArchive, sourceArchiveBytes } from './apehost-source-storage.mjs'

export const SITE = Object.freeze({
  account: '7031244e5dbce80f897a55df4b7c859b', zone: 'e2c7c4a817c98ffccf4b3e964bd9aa13',
  source: 'mailflare', database: '9e15235d-7c72-435e-8a76-09cc9c233c7d', bucket: 'mailflare-raw',
  target: 'omni-mail', targetBucket: 'omni-mail-storage', backupBucket: 'omni-mail-backups',
  hostname: 'mail.apehost.dev', stage: 'omnimail.apehost.dev', catchAll: '889466d315cc4933ac305ddfa144439d',
  domain: '548a11fa307a67cb93aed82811dfb5f55afbb613',
  ruleset: '1ab9208593e04c3292795c102a3c0aae', rule: '283b02e91d1d45a29abf79f38922d729',
  queues: ['mailflare-inbound', 'mailflare-outbound', 'mailflare-agent'],
})
const A = `/accounts/${SITE.account}`, Z = `/zones/${SITE.zone}`
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const requireThat = (ok, message) => { if (!ok) throw new Error(message) }
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const canonical = (value) => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item
})
const same = (a, b) => canonical(a) === canonical(b)
const rows = (items) => items.map(canonical).sort()
const sorted = (items) => [...items].sort((a, b) => a.key.localeCompare(b.key, 'en'))
const objectManifest = (objects) => sorted(objects.map(({ key, size, sha256: hash }) => ({ key, size, sha256: hash })))
const targetIdentity = (id) => ({ worker: SITE.target, databaseId: id, bucket: SITE.targetBucket })
const sourceIdentity = () => ({ worker: SITE.source, databaseId: SITE.database, bucket: SITE.bucket })
const ruleBody = ({ name, enabled, actions, matchers, source }) => ({ name, enabled, actions, matchers, ...(source ? { source } : {}) })
function emailRuleIdentity(rule) {
  const ids = [rule?.id, rule?.tag].filter((id) => id !== undefined)
  requireThat(ids.length > 0 && ids.every((id) => typeof id === 'string' && id.length > 0 && id === ids[0]), 'Invalid or conflicting email rule identity.')
  return ids[0]
}
function normalizeEmailRules(listed, catchAll) {
  requireThat(emailRuleIdentity(catchAll) === SITE.catchAll, 'Unexpected catch-all identity.')
  const seen = new Set()
  return listed.filter((rule) => {
    const id = emailRuleIdentity(rule)
    requireThat(!seen.has(id), 'Repeated email rule identity in inventory.'); seen.add(id)
    if (id !== SITE.catchAll) return true
    requireThat(same(ruleBody(rule), ruleBody(catchAll)), 'Listed catch-all differs from authoritative catch-all.')
    return false
  })
}
const workerAction = (rule) => rule?.enabled === true && rule.actions?.length === 1
  && rule.actions[0].type === 'worker' && rule.actions[0].value?.length === 1 ? rule.actions[0].value[0] : undefined
const protectedDns = (dns) => dns.filter((r) => ['MX', 'TXT'].includes(r.type)).sort((a, b) => a.id.localeCompare(b.id))
const routePattern = (p) => [SITE.hostname, `${SITE.hostname}/*`, `https://${SITE.hostname}/*`].includes(p)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function privatePath(path) {
  requireThat(typeof path === 'string' && path.length > 0, 'An external --state path is required.')
  const absolute = resolve(path), rel = relative(root, absolute)
  requireThat(rel && (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)), 'State and mail backups must be outside the repository.')
  return absolute
}
function save(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}
function parseJson(bytes) {
  try { return JSON.parse(String(bytes).replace(/^\uFEFF/, '')) } catch { throw new Error('Private JSON input is invalid.') }
}
const readJson = (path) => parseJson(readFileSync(path, 'utf8'))
function immutableFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) requireThat(sha256(readFileSync(path)) === sha256(bytes), 'Existing local backup differs; refusing overwrite.')
  else writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
}

export function readSnapshot(path) {
  const bytes = readFileSync(path), data = parseJson(bytes)
  requireThat(data.account === SITE.account && data.database === SITE.database && data.bucket === SITE.bucket, 'Snapshot source identity mismatch.')
  requireThat(Number.isFinite(Date.parse(data.createdAt)) && data.tables && Array.isArray(data.objects), 'Invalid snapshot.')
  for (const name of ['messages', 'message_attachments', 'mailboxes', 'domains']) requireThat(Array.isArray(data.tables[name]), `Snapshot lacks ${name}.`)
  capturedDatabase(data)
  requireThat(new Set(data.objects.map((o) => o.key)).size === data.objects.length, 'Duplicate snapshot object keys.')
  for (const object of data.objects) {
    objectPath(SITE.bucket, object.key)
    const raw = Buffer.from(object.base64 ?? '', 'base64')
    requireThat(raw.toString('base64') === object.base64 && Number.isSafeInteger(object.size) && raw.length === object.size
      && HASH.test(object.sha256) && sha256(raw) === object.sha256, 'Snapshot object bytes/hash mismatch.')
  }
  return { data, bytes, hash: sha256(bytes), objectsHash: sha256(JSON.stringify(objectManifest(data.objects))) }
}

export function validateReceipts(snapshot, parity, runtime, databaseId, command, now = Date.now(), cutoverAt) {
  requireThat(parity?.schema === 'apehost-mail-parity/v1' && parity.verifier?.name === 'verify-mailflare-import'
    && parity.verifier.version === 1 && /^[a-f0-9]{40}$/.test(parity.verifier.revision ?? ''), 'Independent parity receipt is required.')
  requireThat(parity.accountId === SITE.account && same(parity.source, sourceIdentity())
    && Object.entries(targetIdentity(databaseId)).every(([k, v]) => parity.target?.[k] === v), 'Parity receipt source/target mismatch.')
  requireThat(parity.snapshot?.manifestSha256 === snapshot.hash && parity.snapshot.objectsSha256 === snapshot.objectsHash, 'Parity receipt snapshot mismatch.')
  const counts = parity.parity?.counts
  const requiredChecks = ['snapshot-integrity', 'source-mapping', 'worker-bindings', 'framing-policy', 'anonymous-access-denied',
    'original-password-login', 'csrf-rejected', 'target-data-read', 'identity-and-mailboxes', 'all-imported-ids-and-counts',
    'storage-accounting', 'folders-and-pagination', 'body-search', 'owned-session-cleanup',
    ...snapshot.data.objects.map((o) => `object.${sha256(o.key).slice(0, 12)}`),
    ...snapshot.data.tables.messages.flatMap((m) => ['metadata', 'archived-metadata', 'body-and-storage', 'signed-in-api'].map((suffix) => `message.${sha256(m.id).slice(0, 12)}.${suffix}`))]
  requireThat(parity.parity?.verified === true && Array.isArray(parity.parity.checks) && parity.parity.checks.length > 0
    && parity.parity.checks.some((check) => check.required !== false)
    && parity.parity.checks.filter((check) => check.required !== false).every((check) => check.status === 'PASSED')
    && requiredChecks.every((id) => parity.parity.checks.some((check) => check.id === id && check.required === true && check.status === 'PASSED'))
    && counts?.sourceMessages === snapshot.data.tables.messages.length && counts.sourceAttachments === snapshot.data.tables.message_attachments.length
    && counts.sourceObjects === snapshot.data.objects.length && counts.verifiedObjects === counts.sourceObjects
    && counts.verifiedBodies === counts.sourceMessages && counts.importedMessages === counts.sourceMessages
    && counts.importedAttachments === counts.sourceAttachments && counts.targetMessages >= counts.sourceMessages
    && counts.targetAttachments >= counts.sourceAttachments, 'Migration parity is unverified or incomplete.')
  const checkTime = (time) => Number.isFinite(Date.parse(time)) && Date.parse(time) >= Date.parse(snapshot.data.createdAt) && Date.parse(time) <= now + 300_000
  requireThat(checkTime(parity.verifiedAt), 'Parity receipt timestamp is invalid or predates snapshot.')
  if (command === 'backup') return
  requireThat(runtime?.schema === 'apehost-mail-runtime/v1' && runtime.accountId === SITE.account && runtime.zoneId === SITE.zone
    && same(runtime.target, targetIdentity(databaseId)) && runtime.snapshot?.manifestSha256 === snapshot.hash
    && checkTime(runtime.verifiedAt) && runtime.evidence && Object.keys(runtime.evidence).length > 0, 'Independent runtime receipt is required and must match this snapshot/target.')
  const checks = ['stageLogin', 'privateInbox', 'attachments', 'nativeSend', 'framing']
  if (command === 'decommission') checks.push('finalLogin', 'finalInbound', 'finalSend', 'sourceQueuesQuiesced')
  requireThat(checks.every((key) => runtime.checks?.[key] === true), 'Required runtime acceptance remains unverified.')
  if (command === 'decommission') requireThat(Number.isFinite(Date.parse(cutoverAt)) && Date.parse(runtime.verifiedAt) >= Date.parse(cutoverAt), 'Final runtime receipt must follow cutover.')
}

export function objectPath(bucket, key) {
  requireThat(typeof key === 'string' && key.length > 0 && !/[\x00-\x1f\x7f]/.test(key)
    && !key.split('/').some((part) => part === '.' || part === '..'), 'Unsafe R2 object key.')
  return `${A}/r2/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`
}

export function oauthApi({ fetcher = fetch, home = homedir(), spawn = spawnSync } = {}) {
  const auth = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(home, '.cloudflare-oauth', 'cf-oauth-login.ps1')], { stdio: 'pipe', windowsHide: true })
  requireThat(!auth.error && auth.status === 0, 'Cloudflare OAuth helper failed; refresh OAuth before retrying.')
  const credential = readJson(join(home, '.cloudflare-oauth', 'tokens.json'))
  requireThat(typeof credential.access_token === 'string' && credential.access_token.length > 0, 'Cloudflare OAuth session is missing.')
  return async (method, path, { body, binary = false, responseMetadata = false, allow404 = false } = {}) => {
    requireThat(path.startsWith(`${A}/`) || path.startsWith(`${Z}/`), 'Unexpected Cloudflare scope.')
    const headers = { Authorization: `Bearer ${credential.access_token}` }
    if (body !== undefined) headers['Content-Type'] = Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json'
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60_000),
    })
    if (allow404 && response.status === 404) return null
    if (binary && response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer())
      return responseMetadata ? { bytes, contentType: response.headers.get('content-type'), etag: response.headers.get('etag') } : bytes
    }
    let data
    try { data = await response.json() } catch { throw new Error(`Cloudflare ${method} failed: HTTP ${response.status}; invalid response.`) }
    const endpoint = path.split('?')[0].replace(/(\/objects\/).+/, '$1[object]')
    requireThat(response.ok && data?.success === true, `Cloudflare ${method} ${endpoint} failed: HTTP ${response.status}; codes ${(data?.errors ?? []).map((e) => e.code).join(',')}.`)
    return data
  }
}

export async function list(api, path, field) {
  const result = [], cursors = new Set()
  const rulesets = path === `${Z}/rulesets`, emailRules = path === `${Z}/email/routing/rules`
  const pageSize = rulesets || emailRules ? 50 : 100
  let cursor, total, page = 1
  for (let n = 0; n < 1000; n++) {
    const query = new URLSearchParams({ per_page: String(pageSize), ...(cursor ? { cursor } : rulesets ? {} : { page: String(page) }) })
    const data = await api('GET', `${path}${path.includes('?') ? '&' : '?'}${query}`)
    const items = field ? data.result?.[field] : data.result
    requireThat(Array.isArray(items), 'Invalid list response; refusing incomplete inventory.')
    result.push(...items)
    const info = data.result_info
    if (rulesets) {
      const next = info?.cursors?.after
      if (next === undefined || next === null || next === '') return result
      requireThat(typeof next === 'string', 'Invalid ruleset inventory cursor.')
      requireThat(!cursors.has(next), 'Repeated inventory cursor.')
      cursors.add(next); cursor = next; continue
    }
    if (emailRules) {
      requireThat(items.length <= pageSize && (info === undefined || info !== null && typeof info === 'object' && !Array.isArray(info))
        && (info?.page === undefined || info.page === page) && (info?.per_page === undefined || info.per_page === pageSize)
        && (info?.count === undefined || info.count === items.length), 'Invalid email rule inventory pagination metadata.')
      if (info?.total_count !== undefined || total !== undefined) {
        requireThat(Number.isSafeInteger(info?.total_count) && info.total_count >= result.length
          && (total === undefined || total === info.total_count), 'Incomplete or changed email rule inventory total.')
        total = info.total_count
        if (result.length === total) return result
        requireThat(items.length > 0, 'Incomplete email rule inventory page.')
        page++; continue
      }
    }
    if (info?.is_truncated === false) return result
    if (info?.cursor && (info.is_truncated === true || field === 'buckets')) {
      requireThat(!cursors.has(info.cursor), 'Repeated inventory cursor.')
      cursors.add(info.cursor); cursor = info.cursor; continue
    }
    if (info?.is_truncated === true) throw new Error('Truncated inventory has no cursor.')
    if (Number.isInteger(info?.total_pages)) { if (page >= info.total_pages) return result; page++; continue }
    if (items.length < pageSize) return result
    page++
  }
  throw new Error('Inventory pagination limit exceeded.')
}

export async function inventory(api) {
  const [workers, databases, buckets, queues, domains, routes, rulesets, dns, listedEmailRules, sending, durableObjects] = await Promise.all([
    list(api, `${A}/workers/scripts`), list(api, `${A}/d1/database`), list(api, `${A}/r2/buckets`, 'buckets'),
    list(api, `${A}/queues`), list(api, `${A}/workers/domains`), list(api, `${Z}/workers/routes`),
    list(api, `${Z}/rulesets`), list(api, `${Z}/dns_records`), list(api, `${Z}/email/routing/rules`), list(api, `${Z}/email/sending/subdomains`), namespaceCatalog(api),
  ])
  const catchAll = (await api('GET', `${Z}/email/routing/rules/catch_all`)).result
  const emailRules = normalizeEmailRules(listedEmailRules, catchAll)
  const settings = {}, queueDetails = [], ruleDetails = []
  for (const worker of workers) {
    const name = worker.id ?? worker.name
    const config = (await api('GET', `${A}/workers/scripts/${encodeURIComponent(name)}/settings`)).result
    requireThat(Array.isArray(config?.bindings), 'Invalid Worker bindings inventory.')
    settings[name] = { bindings: config.bindings.filter((b) => ['d1', 'r2_bucket', 'queue', 'service', 'durable_object_namespace'].includes(b.type)) }
  }
  for (const queue of queues) queueDetails.push((await api('GET', `${A}/queues/${queue.queue_id}`)).result)
  for (const rule of rulesets) ruleDetails.push((await api('GET', `${Z}/rulesets/${rule.id}`)).result)
  return { workers, databases, buckets, queues: queueDetails, domains, routes, rulesets: ruleDetails, dns, emailRules, catchAll, sending, settings, durableObjects }
}

export function leftovers(view) {
  const has = (value) => /mailflare/i.test(JSON.stringify(value))
  return {
    scope: { account: SITE.account, zone: SITE.zone },
    workers: view.workers.filter(has).map((w) => w.id ?? w.name),
    databases: view.databases.filter((d) => d.uuid === SITE.database || has(d)).map(({ uuid, name }) => ({ id: uuid, name })),
    buckets: view.buckets.filter(has).map((b) => b.name), queues: view.queues.filter(has).map((q) => ({ id: q.queue_id, name: q.queue_name })),
    domains: view.domains.filter(has).map(({ id, hostname, service }) => ({ id, hostname, service })),
    routes: view.routes.filter(has), rules: view.rulesets.flatMap((s) => (s.rules ?? []).filter((r) => r.id === SITE.rule || has(r)).map((r) => ({ ruleset: s.id, rule: r.id }))),
    emailRules: [...view.emailRules.filter(has), ...(has(view.catchAll.actions) ? [view.catchAll] : [])].map((r) => r.id ?? r.tag),
    workerReferences: Object.entries(view.settings).filter(([, v]) => has(v) || v.bindings.some((b) => b.id === SITE.database)).map(([name]) => name),
    durableObjects: view.durableObjects.namespaces.filter((n) => n.id === REALTIME_REVIEW.id || n.script === SITE.source || has(n)),
  }
}

function ownership(view, state, allowMissing = false) {
  const target = view.settings[SITE.target]?.bindings
  requireThat(target?.filter((b) => b.name === 'DB' && b.type === 'd1' && b.id === state.target.databaseId).length === 1
    && target.some((b) => b.type === 'r2_bucket' && b.bucket_name === SITE.targetBucket)
    && target.some((b) => b.type === 'r2_bucket' && b.bucket_name === SITE.backupBucket), 'Unexpected OmniMail resource bindings.')
  requireThat(view.databases.some((d) => d.uuid === state.target.databaseId && d.name === 'omni-mail-db')
    && view.buckets.some((b) => b.name === SITE.targetBucket) && view.buckets.some((b) => b.name === SITE.backupBucket), 'OmniMail storage is missing or mismatched.')
  const source = view.settings[SITE.source]?.bindings
  if (!source) requireThat(allowMissing && state.started['delete-worker'], 'Mailflare Worker disappeared unexpectedly.')
  else requireThat(source.some((b) => b.type === 'd1' && b.id === SITE.database)
    && source.some((b) => b.type === 'r2_bucket' && b.bucket_name === SITE.bucket)
    && source.every((b) => b.type !== 'd1' || b.id === SITE.database)
    && source.every((b) => b.type !== 'r2_bucket' || b.bucket_name === SITE.bucket)
    && source.every((b) => b.type !== 'queue' || SITE.queues.includes(b.queue_name ?? b.queue)), 'Unexpected Mailflare ownership; stop for review.')
  checkSourceStorage(view, state)
  for (const [name, config] of Object.entries(view.settings)) if (name !== SITE.source) {
    requireThat(!config.bindings.some((b) => b.id === SITE.database || b.bucket_name === SITE.bucket
      || b.service === SITE.source || SITE.queues.includes(b.queue_name ?? b.queue)), `Unexpected Mailflare reference in Worker ${name}.`)
  }
  for (const queue of view.queues.filter((q) => SITE.queues.includes(q.queue_name))) {
    const saved = state.original?.queues.find((q) => q.queue_name === queue.queue_name)
    requireThat(!saved || saved.queue_id === queue.queue_id, 'Mailflare queue identity changed.')
    requireThat(Array.isArray(queue.consumers) && Array.isArray(queue.producers)
      && queue.consumers.length === queue.consumers_total_count && queue.producers.length === queue.producers_total_count
      && queue.consumers.every((c) => c.type === 'worker' && (c.script_name ?? c.script) === SITE.source)
      && queue.producers.every((p) => p.type === 'worker' && p.script === SITE.source), 'Unexpected queue owner or incomplete queue references.')
  }
  requireThat(view.queues.every((q) => SITE.queues.includes(q.queue_name)
    || !(q.consumers ?? []).some((c) => (c.script_name ?? c.script) === SITE.source)
      && !(q.producers ?? []).some((p) => p.script === SITE.source)), 'Mailflare references an unexpected queue.')
  requireThat(view.domains.filter((d) => d.hostname === SITE.hostname).length === 1, 'Mail hostname is missing or ambiguous.')
  const domain = view.domains.find((d) => d.hostname === SITE.hostname)
  requireThat(domain.zone_id === SITE.zone && domain.id === SITE.domain && [SITE.source, SITE.target].includes(domain.service), 'Mail hostname has unexpected ownership.')
  requireThat([SITE.source, SITE.target].includes(workerAction(view.catchAll)) && (view.catchAll.id ?? view.catchAll.tag) === SITE.catchAll
    && (!view.catchAll.source || view.catchAll.source === 'api'), 'Catch-all identity/ownership changed.')
  requireThat(view.domains.every((d) => d.service !== SITE.source || d.hostname === SITE.hostname)
    && view.routes.every((r) => r.script !== SITE.source || routePattern(r.pattern))
    && view.emailRules.every((r) => !JSON.stringify(r.actions).includes(SITE.source)), 'Unexpected Mailflare route/domain/email rule remains.')
  for (const set of view.rulesets) for (const rule of set.rules ?? []) {
    requireThat(!/mailflare/i.test(JSON.stringify(rule)) || (set.id === SITE.ruleset && rule.id === SITE.rule), 'Unexpected Mailflare ruleset rule; review before deleting resources.')
  }
  const accountRoutes = view.workers.find((w) => (w.id ?? w.name) === SITE.source)?.routes ?? []
  requireThat(accountRoutes.every((r) => view.routes.some((local) => local.id === r.id) && routePattern(r.pattern)), 'Mailflare has routes outside the captured zone.')
  if (state.original) {
    requireThat(same(protectedDns(view.dns), protectedDns(state.original.dns)) && same(view.sending, state.original.sending), 'MX/TXT or Email Sending onboarding changed; refusing to continue.')
    const expectedCatchAll = ruleBody(state.original.catchAll); expectedCatchAll.actions = view.catchAll.actions
    requireThat(same(ruleBody(view.catchAll), expectedCatchAll)
      && view.routes.filter((r) => r.script === SITE.source).every((r) => state.original.routes.some((old) => old.id === r.id && old.pattern === r.pattern)), 'Routing changed beyond the captured cutover.')
    const oldWorker = state.original.workers.find((w) => (w.id ?? w.name) === SITE.source)
    const currentWorker = view.workers.find((w) => (w.id ?? w.name) === SITE.source)
    if (currentWorker) requireThat(oldWorker?.tag && currentWorker.tag === oldWorker.tag && currentWorker.etag === oldWorker.etag, 'Mailflare Worker identity/content changed since preparation.')
    const currentBucket = view.buckets.find((b) => b.name === SITE.bucket)
    if (currentBucket) requireThat(currentBucket.creation_date === state.original.buckets.find((b) => b.name === SITE.bucket)?.creation_date, 'Mailflare bucket identity changed.')
  }
}

async function query(api, sql, databaseId = SITE.database) {
  const batch = Array.isArray(sql), body = batch ? { batch: sql.map((sql) => ({ sql })) } : { sql }
  const result = (await api('POST', `${A}/d1/database/${databaseId}/query`, { body })).result
  requireThat(Array.isArray(result) && result.length === (batch ? sql.length : 1)
    && result.every((r) => r.success === true && Array.isArray(r.results)), 'Invalid source D1 read response.')
  return batch ? result.map((r) => r.results) : result[0].results
}

async function targetUnchanged(api, parity, state) {
  const proof = parity.targetState, counts = parity.parity.counts
  const prefix = `mailflare_import:${SITE.database}:`
  const expected = [
    ['messages', 'id', counts.sourceMessages, "substr(id,1,4) = 'mfl_'"],
    ['attachments', 'id', counts.sourceAttachments, "substr(id,1,6) = 'mfl_a_'"],
    ['message_search', 'message_id', counts.sourceMessages, "substr(message_id,1,4) = 'mfl_'"],
    ['settings', 'key', counts.sourceMessages, `substr(key,1,${prefix.length}) = '${prefix}'`],
  ]
  requireThat(Array.isArray(proof?.tables) && proof.tables.length === expected.length && Array.isArray(proof.objects)
    && proof.objects.length === counts.sourceObjects + counts.sourceMessages
    && new Set(proof.objects.map((o) => o.key)).size === proof.objects.length, 'Independent target observation proof is required.')
  const data = await query(api, expected.map(([name, , , where]) => `SELECT * FROM ${name} WHERE ${where}`), state.target.databaseId)
  for (const [index, [name, key, count]] of expected.entries()) {
    const recorded = proof.tables.filter((t) => t.name === name)
    const observed = data[index].sort((a, b) => String(a[key]).localeCompare(String(b[key]), 'en'))
    requireThat(recorded.length === 1 && recorded[0].rows === count && observed.length === count
      && HASH.test(recorded[0].sha256) && sha256(canonical(observed)) === recorded[0].sha256, `Target ${name} drifted after independent parity verification.`)
  }
  for (const object of proof.objects) {
    requireThat(Number.isSafeInteger(object.size) && object.size >= 0 && HASH.test(object.sha256), 'Invalid target object observation proof.')
    const bytes = await api('GET', objectPath(SITE.targetBucket, object.key), { binary: true })
    requireThat(bytes.length === object.size && sha256(bytes) === object.sha256, 'Target object drifted after independent parity verification.')
  }
  if (parity.target.deployment) {
    const current = (await api('GET', `${A}/workers/scripts/${SITE.target}/deployments`)).result?.deployments?.[0]
    requireThat(current?.id === parity.target.deployment.id && same(current.versions?.map(({ version_id, percentage }) => ({ id: version_id, percentage })), parity.target.deployment.versions), 'Target deployment changed after parity verification.')
  }
}
const sourceSchema = (api) => query(api, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type, name")
function capturedDatabase(snapshot) {
  const schema = snapshot.schema
  requireThat(Array.isArray(schema) && schema.length > 0 && schema.every((s) => s && same(Object.keys(s).sort(), ['name', 'sql', 'tbl_name', 'type'])
    && ['table', 'index', 'trigger', 'view'].includes(s.type) && typeof s.name === 'string' && s.name && typeof s.tbl_name === 'string' && s.tbl_name
    && (s.sql === null || typeof s.sql === 'string')) && new Set(schema.map((s) => `${s.type}:${s.name}`)).size === schema.length, 'Complete captured D1 schema (type/name/tbl_name/sql) is required.')
  const names = schema.filter((s) => s.type === 'table').map((s) => s.name)
  requireThat(names.every((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) && same([...names].sort(), Object.keys(snapshot.tables).sort())
    && Object.values(snapshot.tables).every((values) => Array.isArray(values) && values.length <= 10_000 && values.every((r) => r && typeof r === 'object' && !Array.isArray(r))), 'Incomplete captured D1 table coverage or rows.')
  return { schema, tables: Object.fromEntries(Object.entries(snapshot.tables).map(([k, v]) => [k, rows(v)])) }
}
async function baselineSource(api, snapshot) {
  const db = capturedDatabase(snapshot.data)
  requireThat(same(db.schema, await sourceSchema(api)), 'Source schema changed or captured full schema is incomplete.')
  const names = ['messages', 'message_attachments', 'mailboxes', 'domains']
  const verifyRows = async () => {
    const data = await query(api, names.map((name) => `SELECT * FROM "${name}" LIMIT 10001`))
    for (const [index, name] of names.entries()) {
      const current = new Map(data[index].map((r) => [r.id, r]))
      requireThat(data[index].length <= 10_000 && current.size === data[index].length && data[index].every((r) => typeof r.id === 'string'), 'Incomplete baseline D1 observation.')
      for (const old of snapshot.data.tables[name]) requireThat(typeof old.id === 'string' && same(current.get(old.id), old), `Source ${name} changed since snapshot; refresh/import/verify again.`)
    }
    const ids = new Set(snapshot.data.tables.messages.map((m) => m.id))
    requireThat(same(rows(data[1].filter((a) => ids.has(a.message_id))), rows(snapshot.data.tables.message_attachments)), 'Baseline attachment membership changed since snapshot.')
  }
  await verifyRows()
  const objects = await list(api, `${A}/r2/buckets/${SITE.bucket}/objects`), present = new Map(objects.map((o) => [o.key, o]))
  requireThat(present.size === objects.length, 'Duplicate source R2 inventory keys.')
  for (const old of snapshot.data.objects) requireThat(present.get(old.key)?.size === old.size
    && sha256(await api('GET', objectPath(SITE.bucket, old.key), { binary: true })) === old.sha256, 'Source R2 bytes changed or disappeared since snapshot.')
  await verifyRows()
  requireThat(same(db.schema, await sourceSchema(api)), 'Source schema changed during baseline verification.')
  return db
}
async function sourceDatabase(api) {
  const schema = await sourceSchema(api)
  const tables = {}, names = schema.filter((t) => t.type === 'table').map((t) => t.name)
  requireThat(names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)), 'Unsupported source table name.')
  for (let offset = 0; offset < names.length; offset += 10) {
    const batch = names.slice(offset, offset + 10)
    const data = await query(api, batch.flatMap((name) => [`SELECT COUNT(*) AS n FROM "${name}"`, `SELECT * FROM "${name}" LIMIT 10001`]))
    for (const [index, name] of batch.entries()) {
      const count = data[index * 2][0]?.n
      // shortcut: small private mailbox snapshots fit one D1 result; add pagination before larger migrations.
      requireThat(Number.isSafeInteger(count) && count <= 10_000, 'Source table needs a paginated backup; refusing partial export.')
      tables[name] = data[index * 2 + 1]
      requireThat(tables[name].length === count, 'Source D1 export was truncated or changed during read.')
    }
  }
  return { schema, tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, rows(v)])) }
}
async function freshSource(api, snapshot, state, partial = false) {
  const databaseExists = !partial || (await list(api, `${A}/d1/database`)).some((d) => d.uuid === SITE.database)
  let database
  if (databaseExists) {
    database = await sourceDatabase(api)
    for (const [name, values] of Object.entries(snapshot.data.tables)) requireThat(same(database.tables[name], rows(values)), `Source ${name} changed since snapshot; refresh/import/verify again.`)
    if (state.backup) requireThat(sha256(Buffer.from(canonical(database))) === state.backup.databaseSha256, 'Source D1 changed since backup.')
  } else requireThat(state.started['delete-database'], 'Source D1 disappeared without a recorded deletion intent.')
  const bucketExists = !partial || (await list(api, `${A}/r2/buckets`, 'buckets')).some((b) => b.name === SITE.bucket)
  const objects = bucketExists ? await list(api, `${A}/r2/buckets/${SITE.bucket}/objects`) : []
  if (!bucketExists) requireThat(state.started['delete-bucket'], 'Source bucket disappeared without deletion intent.')
  const expected = new Map(snapshot.data.objects.map((o) => [o.key, o]))
  requireThat(objects.length <= expected.size && (partial || objects.length === expected.size), 'Source R2 object inventory changed.')
  for (const object of objects) {
    const old = expected.get(object.key)
    requireThat(old && old.size === object.size && sha256(await api('GET', objectPath(SITE.bucket, object.key), { binary: true })) === old.sha256, 'Source R2 bytes changed since snapshot.')
    expected.delete(object.key)
  }
  for (const key of expected.keys()) requireThat(partial && state.started[`delete-object:${key}`], 'Source R2 object disappeared without deletion intent.')
  if (database) requireThat(same(database, await sourceDatabase(api)), 'Source changed during freshness verification.')
  return database
}

export async function step(state, id, { execute, saveState, apply, done, plans }) {
  if (await done()) {
    if (execute) { state.completed[id] = true; saveState() }
    return
  }
  plans.push(id)
  if (!execute) return
  state.started[id] = true; saveState()
  await apply()
  requireThat(await done(), `Step ${id} did not reach its expected state; saved intent permits safe retry.`)
  state.completed[id] = true; saveState()
}

export async function runCutover(command, options, { api, now = () => new Date().toISOString() } = {}) {
  requireThat(['status', 'audit', 'prepare', 'backup', 'cutover', 'rollback', 'decommission'].includes(command), 'Use status, audit, prepare, backup, cutover, rollback or decommission.')
  const execute = options.execute === true && !['status', 'audit'].includes(command)
  const statePath = options.state ? privatePath(options.state) : undefined
  requireThat(['status', 'audit'].includes(command) || statePath, 'An external --state path is required.')
  let lock
  if (execute) { mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 }); lock = openSync(`${statePath}.lock`, 'wx', 0o600) }
  try {
    api ??= oauthApi()
    let view = await inventory(api)
    let state = statePath && existsSync(statePath) ? readJson(statePath) : undefined
    if (['status', 'audit'].includes(command)) return { command, readOnly: true, phase: state?.phase ?? 'unprepared', leftovers: leftovers(view) }
    const plans = [], saveState = () => save(statePath, state)
    if (command === 'prepare') {
      if (state) requireThat(state.schema === 'apehost-mail-cutover/v1' && state.accountId === SITE.account && state.zoneId === SITE.zone, 'Invalid existing state.')
      else {
        const id = view.settings[SITE.target]?.bindings.find((b) => b.name === 'DB' && b.type === 'd1')?.id
        requireThat(UUID.test(id ?? '') && id !== SITE.database, 'Stage OmniMail with its own database before prepare.')
        state = { schema: 'apehost-mail-cutover/v1', accountId: SITE.account, zoneId: SITE.zone, target: targetIdentity(id), phase: 'prepared', capturedAt: now(), started: {}, completed: {} }
        ownership(view, state)
        requireThat(view.domains.find((d) => d.hostname === SITE.hostname).service === SITE.source
          && view.domains.find((d) => d.hostname === SITE.hostname).id === SITE.domain && workerAction(view.catchAll) === SITE.source, 'Initial capture requires original Mailflare routing.')
        requireThat(SITE.queues.every((name) => view.queues.some((q) => q.queue_name === name)), 'Expected Mailflare queue is missing.')
        state.original = view
      }
      ownership(view, state, state.phase === 'decommissioning')
      await prepareSourceArchive(api, view, state, statePath, execute, now, saveState)
      if (execute) saveState()
      return { command, execute, target: state.target, plans: ['save-original-control-plane'], phase: state.phase }
    }
    requireThat(state?.schema === 'apehost-mail-cutover/v1' && state.accountId === SITE.account && state.zoneId === SITE.zone
      && UUID.test(state.target?.databaseId ?? '') && state.target.databaseId !== SITE.database && same(state.target, targetIdentity(state.target.databaseId))
      && state.original && state.started && state.completed, 'Valid saved preparation state is required.')
    const snapshot = readSnapshot(options.snapshot), parityBytes = readFileSync(options['parity-receipt'])
    const parity = parseJson(parityBytes), runtime = options['runtime-receipt'] ? readJson(options['runtime-receipt']) : undefined
    validateReceipts(snapshot, parity, runtime, state.target.databaseId, command, Date.parse(now()), state.cutoverAt)
    ownership(view, state, command === 'decommission' && ['decommissioning', 'decommissioned'].includes(state.phase))
    const sourceArchive = sourceArchiveBytes(state, statePath)
    const doStep = (id, apply, done) => step(state, id, { execute, saveState, apply: async () => {
      if (!id.startsWith('delete-object:')) ownership(await refresh(), state, command === 'decommission')
      await apply()
    }, done, plans })
    const refresh = async () => { view = await inventory(api); return view }
    if (command === 'backup') {
      requireThat(!['decommissioning', 'decommissioned'].includes(state.phase), 'Cannot replace backup during or after deletion.')
      const db = await baselineSource(api, snapshot)
      await targetUnchanged(api, parity, state)
      const artifacts = { 'snapshot.json': snapshot.bytes, 'source-d1.json': Buffer.from(canonical(db)), 'control-plane.json': Buffer.from(canonical(state.original)), 'parity.json': parityBytes }
      if (sourceArchive) { await emptyNamespace(api); artifacts['source-worker.json'] = sourceArchive }
      const parityHash = sha256(parityBytes)
      const prefix = `mailflare-retirement/${snapshot.hash}/${parityHash}`, directory = join(dirname(statePath), `mailflare-backup-${snapshot.hash}`, parityHash)
      for (const [name, bytes] of Object.entries(artifacts)) {
        requireThat(bytes.length <= 300_000_000, 'Backup artifact exceeds R2 HTTP upload limit.')
        const path = objectPath(SITE.backupBucket, `${prefix}/${name}`)
        const current = await api('GET', path, { binary: true, allow404: true })
        if (current !== null) requireThat(sha256(current) === sha256(bytes), 'Remote backup key already contains different bytes.')
        if (execute) {
          immutableFile(join(directory, name), bytes)
          if (current === null) await api('PUT', path, { body: bytes })
          requireThat(sha256(await api('GET', path, { binary: true })) === sha256(bytes), 'Independent backup GET/hash verification failed.')
        }
        plans.push(`verify-backup:${name}`)
      }
      if (execute) {
        await baselineSource(api, snapshot)
        state.backup = { kind: 'captured-d1/v1', capturedAt: snapshot.data.createdAt, snapshotSha256: snapshot.hash, databaseSha256: sha256(artifacts['source-d1.json']), paritySha256: sha256(parityBytes), directory, prefix, verifiedAt: now(), artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, sha256(bytes)])) }
        saveState()
      }
      return { command, execute, plans, kind: 'captured-d1/v1', capturedAt: snapshot.data.createdAt, snapshotSha256: snapshot.hash }
    }
    requireThat(state.backup?.kind === 'captured-d1/v1' && state.backup.capturedAt === snapshot.data.createdAt && state.backup.snapshotSha256 === snapshot.hash && state.backup.paritySha256 === sha256(parityBytes)
      && state.backup.prefix === `mailflare-retirement/${snapshot.hash}/${sha256(parityBytes)}`
      && state.backup.directory === join(dirname(statePath), `mailflare-backup-${snapshot.hash}`, sha256(parityBytes))
      && same(Object.keys(state.backup.artifacts ?? {}).sort(), ['control-plane.json', 'parity.json', 'snapshot.json', 'source-d1.json', ...(sourceArchive ? ['source-worker.json'] : [])].sort())
      && state.backup.artifacts['snapshot.json'] === snapshot.hash && state.backup.artifacts['parity.json'] === sha256(parityBytes)
      && state.backup.artifacts['source-d1.json'] === state.backup.databaseSha256
      && state.backup.databaseSha256 === sha256(Buffer.from(canonical(capturedDatabase(snapshot.data))))
      && state.backup.artifacts['control-plane.json'] === sha256(Buffer.from(canonical(state.original)))
      && (!sourceArchive || state.backup.artifacts['source-worker.json'] === sha256(sourceArchive)), 'Latest verified snapshot/receipt must be backed up first.')
    for (const [name, hash] of Object.entries(state.backup.artifacts)) {
      requireThat(HASH.test(hash) && sha256(readFileSync(join(state.backup.directory, name))) === hash
        && sha256(await api('GET', objectPath(SITE.backupBucket, `${state.backup.prefix}/${name}`), { binary: true })) === hash, 'Local/independent remote backup verification failed.')
    }
    if (command === 'cutover' || command === 'rollback') {
      requireThat(!['decommissioning', 'decommissioned'].includes(state.phase), 'Storage retirement started; automatic rollback/cutover is unavailable.')
      if (command === 'cutover') { await targetUnchanged(api, parity, state); await baselineSource(api, snapshot) }
      const worker = command === 'cutover' ? SITE.target : SITE.source
      const alreadyCutover = state.phase === 'cutover'
      const oldDomain = state.original.domains.find((d) => d.hostname === SITE.hostname)
      await doStep(`${command}-domain`, () => api('PUT', `${A}/workers/domains`, { body: { hostname: SITE.hostname, zone_id: SITE.zone, service: worker, enabled: oldDomain.enabled, previews_enabled: oldDomain.previews_enabled } }), async () => (await refresh()).domains.some((d) => d.hostname === SITE.hostname && d.service === worker && d.enabled !== false))
      for (const route of state.original.routes.filter((r) => r.script === SITE.source)) {
        const current = view.routes.find((r) => r.id === route.id)
        requireThat(current?.pattern === route.pattern && [SITE.source, SITE.target].includes(current.script), 'Saved route identity changed.')
        await doStep(`${command}-route:${route.id}`, () => api('PUT', `${Z}/workers/routes/${route.id}`, { body: { pattern: route.pattern, script: worker } }), async () => (await refresh()).routes.some((r) => r.id === route.id && r.script === worker && r.pattern === route.pattern))
      }
      const desired = ruleBody(state.original.catchAll); desired.actions = [{ type: 'worker', value: [worker] }]
      await doStep(`${command}-catch-all`, () => api('PUT', `${Z}/email/routing/rules/catch_all`, { body: desired }), async () => same(ruleBody((await refresh()).catchAll), desired))
      if (execute) { ownership(view, state); state.phase = command === 'cutover' ? 'cutover' : 'rolled-back'; if (command === 'cutover' && !alreadyCutover) state.cutoverAt = now(); saveState() }
      return { command, execute, plans, phase: state.phase }
    }
    requireThat(['cutover', 'decommissioning', 'decommissioned'].includes(state.phase), 'Saved inbound cutover is required before decommission.')
    requireThat(view.domains.some((d) => d.hostname === SITE.hostname && d.service === SITE.target) && workerAction(view.catchAll) === SITE.target
      && !view.routes.some((r) => r.script === SITE.source), 'Inbound/hostname routing has not fully cut over.')
    await targetUnchanged(api, parity, state)
    await freshSource(api, snapshot, state, state.phase !== 'cutover')
    const emptyQueue = async (queue) => {
      const data = (await api('GET', `${A}/queues/${queue.queue_id}/metrics`)).result
      requireThat(data?.backlog_count === 0 && data.backlog_bytes === 0 && (data.oldest_message_timestamp_ms === 0 || data.oldest_message_timestamp_ms === null), 'Mailflare queue is not demonstrably empty; drain without purging.')
    }
    for (const queue of view.queues.filter((q) => SITE.queues.includes(q.queue_name))) await emptyQueue(queue)
    if (execute) { state.phase = 'decommissioning'; saveState() }
    for (const saved of state.original.queues.filter((q) => SITE.queues.includes(q.queue_name))) {
      const queue = view.queues.find((q) => q.queue_id === saved.queue_id)
      if (!queue) { requireThat(state.started[`delete-queue:${saved.queue_id}`], 'Source queue disappeared unexpectedly.'); continue }
      for (const consumer of queue.consumers) await doStep(`delete-consumer:${consumer.consumer_id}`, async () => { await emptyQueue(queue); await api('DELETE', `${A}/queues/${queue.queue_id}/consumers/${consumer.consumer_id}`) }, async () => !(await refresh()).queues.find((q) => q.queue_id === queue.queue_id)?.consumers.some((c) => c.consumer_id === consumer.consumer_id))
    }
    await doStep('delete-worker', async () => {
      for (const q of view.queues.filter((q) => SITE.queues.includes(q.queue_name))) await emptyQueue(q)
      await freshSource(api, snapshot, state)
      ownership(await refresh(), state)
      if (sourceArchive) await emptyNamespace(api)
      await api('DELETE', `${A}/workers/scripts/${SITE.source}?force=false`)
    }, async () => { await refresh(); checkSourceStorage(view, state); return !view.settings[SITE.source] && Boolean(state.started['delete-worker']) })
    for (const queue of state.original.queues.filter((q) => SITE.queues.includes(q.queue_name))) {
      await doStep(`delete-queue:${queue.queue_id}`, async () => {
        const current = (await api('GET', `${A}/queues/${queue.queue_id}`)).result
        requireThat(current.queue_name === queue.queue_name && current.consumers?.length === 0 && current.producers?.length === 0 && current.consumers_total_count === 0 && current.producers_total_count === 0, 'Queue still has consumer/producer references.')
        await emptyQueue(queue); await api('DELETE', `${A}/queues/${queue.queue_id}`)
      }, async () => !(await refresh()).queues.some((q) => q.queue_id === queue.queue_id) && Boolean(state.started[`delete-queue:${queue.queue_id}`]))
    }
    await targetUnchanged(api, parity, state)
    await freshSource(api, snapshot, state, true)
    for (const object of snapshot.data.objects) await doStep(`delete-object:${object.key}`, async () => {
      requireThat(sha256(await api('GET', objectPath(SITE.bucket, object.key), { binary: true })) === object.sha256, 'Source object changed immediately before deletion.')
      await api('DELETE', objectPath(SITE.bucket, object.key))
    }, async () => {
      const present = await api('GET', objectPath(SITE.bucket, object.key), { binary: true, allow404: true }) !== null
      requireThat(present || state.started[`delete-object:${object.key}`], 'Source object vanished unexpectedly.')
      return !present
    })
    await doStep('delete-bucket', async () => { requireThat((await list(api, `${A}/r2/buckets/${SITE.bucket}/objects`)).length === 0, 'Source bucket is not empty.'); await api('DELETE', `${A}/r2/buckets/${SITE.bucket}`) }, async () => !(await refresh()).buckets.some((b) => b.name === SITE.bucket) && Boolean(state.started['delete-bucket']))
    await doStep('delete-database', async () => { await targetUnchanged(api, parity, state); await freshSource(api, snapshot, state, true); await api('DELETE', `${A}/d1/database/${SITE.database}`) }, async () => !(await refresh()).databases.some((d) => d.uuid === SITE.database) && Boolean(state.started['delete-database']))
    const originalRule = state.original.rulesets.find((s) => s.id === SITE.ruleset)?.rules?.find((r) => r.id === SITE.rule)
    await doStep('delete-obsolete-rule', async () => {
      const current = view.rulesets.find((s) => s.id === SITE.ruleset)?.rules?.find((r) => r.id === SITE.rule)
      requireThat(originalRule && same(current, originalRule), 'Obsolete rule changed; refusing deletion.')
      await api('DELETE', `${Z}/rulesets/${SITE.ruleset}/rules/${SITE.rule}`)
    }, async () => !(await refresh()).rulesets.find((s) => s.id === SITE.ruleset)?.rules?.some((r) => r.id === SITE.rule))
    if (execute) { ownership(await refresh(), state, true); state.phase = 'decommissioned'; saveState() }
    return { command, execute, plans, phase: state.phase, leftovers: leftovers(view) }
  } finally {
    if (lock !== undefined) { closeSync(lock); unlinkSync(`${statePath}.lock`) }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['state', 'snapshot', 'parity-receipt', 'runtime-receipt'].map((key) => [key, { type: 'string' }]).concat([['execute', { type: 'boolean' }]])) })
  try {
    requireThat(positionals.length === 1, 'Supply exactly one command; default is dry-run. --execute permits mutations.')
    console.log(JSON.stringify(await runCutover(positionals[0], values), null, 2))
  } catch (error) { console.error(error instanceof Error ? error.message : 'Cutover failed.'); process.exitCode = 1 }
}
