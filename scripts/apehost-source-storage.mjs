import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// This exception covers only the shipped, independently reviewed storage-free Hub.
export const REALTIME_REVIEW = Object.freeze({
  account: '7031244e5dbce80f897a55df4b7c859b', worker: 'mailflare',
  id: '702f544aa78e480db6bb37f2aac86380', name: 'mailflare_RealtimeHub', class: 'RealtimeHub',
  etag: '203f2efecc8d108bb8e7ea28c81068b06725d5f539dccd02c37e86f56194bd3c',
  moduleSha256: '1ca6ac183d86b79010282f2b5ed3a1612a9d160667adfc9fb0434cc7c21b0985',
  classSha256: 'd97cd6d46f948bc47a95df224df58777c930fd21aec0bb70b66b6e3120871cfe',
})
const R = REALTIME_REVIEW, A = `/accounts/${R.account}`, N = `${A}/workers/durable_objects/namespaces`
const requireThat = (ok, message) => { if (!ok) throw new Error(message) }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)
const same = (a, b) => canonical(a) === canonical(b)
const etag = (value) => typeof value === 'string' ? value.replace(/^"|"$/g, '') : undefined
const owned = (namespaces) => namespaces.filter((n) => n.id === R.id || n.script === R.worker || n.name?.startsWith(`${R.worker}_`))
const binding = { type: 'durable_object_namespace', name: 'REALTIME', namespace_id: R.id, class_name: R.class }
const selfReference = { type: 'service', name: 'WORKER_SELF_REFERENCE', service: R.worker, environment: 'production' }

export async function namespaceCatalog(api) {
  const namespaces = [], pages = [], ids = new Set()
  let total
  for (let page = 1; page <= 1000; page++) {
    const data = await api('GET', `${N}?${new URLSearchParams({ page: String(page), per_page: '1000' })}`)
    const info = data.result_info, items = data.result
    requireThat(Array.isArray(items) && info?.page === page && info.per_page === 1000 && info.count === items.length
      && Number.isSafeInteger(info.total_count) && info.total_count >= 0 && (total === undefined || total === info.total_count), 'Incomplete or changed Durable Object namespace catalog.')
    total = info.total_count
    for (const item of items) {
      requireThat(/^[a-f0-9]{32}$/.test(item.id ?? '') && typeof item.name === 'string' && typeof item.script === 'string'
        && typeof item.class === 'string' && typeof item.use_sqlite === 'boolean' && !ids.has(item.id), 'Invalid or repeated Durable Object namespace catalog entry.')
      ids.add(item.id)
    }
    namespaces.push(...items); pages.push({ result_info: info, count: items.length })
    requireThat(namespaces.length <= total && items.length <= 1000, 'Invalid Durable Object namespace catalog count.')
    if (namespaces.length === total) return { namespaces, pages }
    requireThat(items.length === 1000, 'Incomplete Durable Object namespace catalog page.')
  }
  throw new Error('Durable Object namespace catalog pagination limit exceeded.')
}

function emptyPage(page, ids, cursors) {
  const cursor = page.result_info?.cursor
  requireThat(Array.isArray(page.result) && page.result.length <= 1000 && typeof cursor === 'string' && cursor.length <= 4096
    && !/[\x00-\x1f\x7f]/.test(cursor) && (!cursor || !cursors.has(cursor)), 'Invalid or repeated Durable Object object cursor.')
  if (page.result_info.count !== undefined) requireThat(page.result_info.count === page.result.length, 'Incomplete Durable Object object page.')
  for (const object of page.result) {
    requireThat(/^[a-f0-9]{64}$/.test(object.id ?? '') && !ids.has(object.id) && object.hasStoredData === false,
      'Durable Object has stored data, uncertain storage flags or a duplicate identity; stop for storage review.')
    ids.add(object.id)
  }
  if (cursor) cursors.add(cursor)
  return cursor
}
function validateEmptyProof(proof) {
  requireThat(proof?.namespaceId === R.id && Array.isArray(proof.pages) && proof.pages.length > 0 && proof.pages.length <= 1000, 'Incomplete Durable Object emptiness proof.')
  const ids = new Set(), cursors = new Set()
  for (const [index, page] of proof.pages.entries()) {
    const cursor = emptyPage(page, ids, cursors)
    requireThat(Boolean(cursor) === (index < proof.pages.length - 1), 'Incomplete Durable Object proof cursor chain.')
  }
}
export async function emptyNamespace(api) {
  const pages = [], ids = new Set(), cursors = new Set()
  let cursor = ''
  for (let n = 0; n < 1000; n++) {
    const query = new URLSearchParams({ limit: '1000', ...(cursor ? { cursor } : {}) })
    const data = await api('GET', `${N}/${R.id}/objects?${query}`)
    const page = { result: data.result, result_info: data.result_info }
    cursor = emptyPage(page, ids, cursors); pages.push(page)
    if (!cursor) return { namespaceId: R.id, pages }
  }
  throw new Error('Durable Object object pagination limit exceeded.')
}

export function checkSourceStorage(view, state) {
  requireThat(Array.isArray(view.durableObjects?.namespaces), 'Complete Durable Object namespace catalog is required.')
  const namespaces = owned(view.durableObjects.namespaces)
  const source = view.workers.find((w) => (w.id ?? w.name) === R.worker)
  const bindings = view.settings[R.worker]?.bindings ?? []
  const durable = bindings.filter((b) => b.type === 'durable_object_namespace'), services = bindings.filter((b) => b.type === 'service')
  const exported = Object.entries(source?.exports ?? {}).filter(([, e]) => ['durable-object', 'class'].includes(e.type))
  const classes = (source?.named_handlers ?? []).filter((h) => h.handlers?.includes('class'))
  const original = state?.original?.settings?.[R.worker]?.bindings.some((b) => b.type === 'durable_object_namespace')
  const reviewed = Boolean(original || namespaces.length || durable.length || classes.length || exported.length)
  for (const [name, config] of Object.entries(view.settings)) if (name !== R.worker) {
    requireThat(!config.bindings.some((b) => b.type === 'durable_object_namespace'
      && (b.namespace_id === R.id || b.script_name === R.worker || b.script === R.worker)), `Unexpected Mailflare reference in Worker ${name}.`)
  }
  if (!source) {
    requireThat(namespaces.length === 0, 'Mailflare Durable Object namespace remains after Worker deletion; stop before further retirement.')
    return reviewed
  }
  if (!reviewed) {
    requireThat(services.length === 0, 'Unreviewed Mailflare service binding; stop for review.')
    return false
  }
  requireThat(etag(source.etag) === R.etag && durable.length === 1 && same(durable[0], binding)
    && namespaces.length === 1 && Object.entries({ id: R.id, name: R.name, script: R.worker, class: R.class, use_sqlite: true }).every(([k, v]) => namespaces[0][k] === v)
    && classes.every((h) => h.name === R.class && same(h.handlers, ['class'])) && exported.every(([name, e]) => name === R.class && e.type === 'durable-object')
    && (classes.length === 1 || exported.length === 1) && classes.length <= 1 && exported.length <= 1
    && services.length === 1 && same(services[0], selfReference), 'Mailflare Durable Objects or self-reference differ from the exact reviewed source; stop for storage review.')
  return true
}

function validateArchive(archive, original) {
  const worker = archive?.worker, bytes = Buffer.from(worker?.bodyBase64 ?? '', 'base64')
  requireThat(archive?.schema === 'apehost-mail-source-worker/v1' && same(archive.review, R) && etag(worker?.etag) === R.etag
    && typeof worker.contentType === 'string' && /^multipart\/form-data;\s*boundary=/.test(worker.contentType) && !/[\r\n]/.test(worker.contentType)
    && bytes.length > 0 && bytes.toString('base64') === worker.bodyBase64 && sha256(bytes) === worker.sha256
    && same(worker.metadata, original.workers.find((w) => (w.id ?? w.name) === R.worker))
    && Array.isArray(archive.settings?.bindings), 'Invalid original Mailflare Worker archive.')
  const relevant = archive.settings.bindings.filter((b) => ['d1', 'r2_bucket', 'queue', 'service', 'durable_object_namespace'].includes(b.type))
  requireThat(same(relevant, original.settings[R.worker].bindings) && same(archive.catalog, original.durableObjects), 'Mailflare Worker archive differs from captured ownership.')
  checkSourceStorage({ ...original, settings: { ...original.settings, [R.worker]: archive.settings } })
  validateEmptyProof(archive.empty)
}
export function sourceArchiveBytes(state, statePath) {
  if (!state.original.settings[R.worker]?.bindings.some((b) => b.type === 'durable_object_namespace')) return undefined
  const saved = state.sourceArchive
  requireThat(saved?.path === `${statePath}.source-worker.json` && /^[a-f0-9]{64}$/.test(saved.sha256) && existsSync(saved.path), 'Original Mailflare Worker archive is missing or mismatched.')
  const bytes = readFileSync(saved.path)
  requireThat(sha256(bytes) === saved.sha256, 'Original Mailflare Worker archive hash verification failed.')
  let archive
  try { archive = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) } catch { throw new Error('Private JSON input is invalid.') }
  validateArchive(archive, state.original)
  return bytes
}
export async function prepareSourceArchive(api, view, state, statePath, execute, now, saveState) {
  if (!checkSourceStorage(view, state)) return
  const empty = await emptyNamespace(api), path = `${statePath}.source-worker.json`
  if (state.sourceArchive) { sourceArchiveBytes(state, statePath); return }
  let bytes
  if (existsSync(path)) bytes = readFileSync(path)
  else {
    const download = await api('GET', `${A}/workers/scripts/${R.worker}`, { binary: true, responseMetadata: true })
    const settings = (await api('GET', `${A}/workers/scripts/${R.worker}/settings`)).result
    requireThat(Buffer.isBuffer(download?.bytes) && etag(download.etag) === R.etag, 'Downloaded Mailflare source differs from reviewed ETag.')
    bytes = Buffer.from(canonical({ schema: 'apehost-mail-source-worker/v1', capturedAt: now(), review: R,
      worker: { metadata: view.workers.find((w) => (w.id ?? w.name) === R.worker), etag: download.etag, contentType: download.contentType,
        bodyBase64: download.bytes.toString('base64'), sha256: sha256(download.bytes) }, settings, catalog: state.original.durableObjects, empty }))
  }
  let archive
  try { archive = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) } catch { throw new Error('Private JSON input is invalid.') }
  validateArchive(archive, state.original)
  if (execute) {
    // Save the original inventory first: a crash after the immutable file write can reuse it.
    saveState()
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
    state.sourceArchive = { path, sha256: sha256(bytes) }
  }
}
