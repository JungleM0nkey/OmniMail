import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  archiveKey, attachmentId, equal, ensure, expectedAttachment, expectedMessages, expectedSummary,
  mailboxAddress, messageId, objectKey, searchContent, sha256, stableJson,
  validateSnapshot, verifyArchive, verifyFramePolicy,
} from './verify-mailflare-snapshot.mjs'

const TIMEOUT = 30_000
const readJson = (filename) => JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''))
const safeError = (error) => /^[a-z0-9_.-]+(?: HTTP \d{3})?$/.test(error?.message || '')
  ? error.message : 'check.failed-with-private-details-suppressed'

export function cloudflareReader(account, database, bucket, token, request = fetch) {
  async function read(path, body) {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    ensure(response.ok, `cloudflare HTTP ${response.status}`)
    return response
  }
  async function json(path, body) {
    const value = await (await read(path, body)).json()
    ensure(value.success === true, 'cloudflare.response.unsuccessful')
    return value.result
  }
  return {
    async query(sql, params = []) {
      ensure(/^SELECT\s/i.test(sql), 'cloudflare.query.must-be-read-only')
      const result = await json(`/d1/database/${encodeURIComponent(database)}/query`, { sql, params })
      ensure(result.length === 1 && result[0].success !== false && Array.isArray(result[0].results), 'cloudflare.query.invalid-result')
      return result[0].results
    },
    async object(key) {
      const path = key.split('/').map(encodeURIComponent).join('/')
      return Buffer.from(await (await read(`/r2/buckets/${encodeURIComponent(bucket)}/objects/${path}`)).arrayBuffer())
    },
    settings: () => json('/workers/scripts/omni-mail/settings'),
    deployments: () => json('/workers/scripts/omni-mail/deployments'),
  }
}

export function apiReader(base, request = fetch) {
  let cookie = ''
  return async function api(path, options = {}) {
    const { anonymous = false, origin, json, ...init } = options
    ensure(path.startsWith('/api/') || path === '/', 'api.path.invalid')
    const response = await request(new URL(path, base), {
      ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT),
      headers: { ...(!anonymous && cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) },
      ...(json ? { body: JSON.stringify(json) } : {}),
    })
    if (path === '/api/login' && response.status === 200) {
      const cookies = response.headers.getSetCookie()
      const session = cookies.find((value) => /^omnimail_session=/.test(value))
      ensure(session && /;\s*HttpOnly(?:;|$)/i.test(session) && /;\s*Secure(?:;|$)/i.test(session)
        && /;\s*SameSite=Lax(?:;|$)/i.test(session), 'login.session-cookie.invalid')
      cookie = session.split(';')[0]
    }
    return response
  }
}

export async function verifyImport(options, clients) {
  const { snapshot, snapshotBytes, account, database, bucket, base, credentials, revision = 'UNVERIFIED' } = options
  const receipt = {
    schema: 'apehost-mail-parity/v1', verifiedAt: new Date().toISOString(),
    verifier: { name: 'verify-mailflare-import', version: 1, revision }, accountId: account,
    source: { worker: 'mailflare', databaseId: snapshot?.database, bucket: snapshot?.bucket },
    target: { worker: 'omni-mail', base, databaseId: database, bucket },
    snapshot: { manifestSha256: sha256(snapshotBytes) },
    parity: { verified: false, checks: [], counts: {} },
    remainingAcceptance: [
      { id: 'live-send-and-receive', status: 'UNVERIFIED', reason: 'Parent must verify live delivery; this script sends no email.' },
      { id: 'console-harness', status: 'UNVERIFIED', reason: 'Parent owns the shared Harness and signed-in dock flow.' },
      { id: 'browser-framing', status: 'UNVERIFIED', reason: 'Headers are checked here; browser enforcement needs Harness evidence.' },
      { id: 'source-freshness-and-retirement', status: 'UNVERIFIED', reason: 'Compare current source before retirement using the guarded cutover procedure.' },
    ],
  }
  const check = async (id, action, required = true) => {
    try {
      await action()
      receipt.parity.checks.push({ id, status: 'PASSED', required })
      return true
    } catch (error) {
      receipt.parity.checks.push({ id, status: 'FAILED', required, reason: safeError(error) })
      return false
    }
  }
  const unverified = (id, reason, required = true) => receipt.parity.checks.push({ id, status: 'UNVERIFIED', required, reason })
  const finish = () => {
    receipt.verifiedAt = new Date().toISOString()
    const required = receipt.parity.checks.filter((item) => item.required)
    receipt.parity.verified = required.length > 0 && required.every((item) => item.status === 'PASSED')
    receipt.status = receipt.parity.verified ? 'PASSED' : required.some((item) => item.status === 'FAILED') ? 'FAILED' : 'UNVERIFIED'
    return receipt
  }
  let model
  if (!await check('snapshot-integrity', () => {
    model = validateSnapshot(snapshot)
    equal(snapshot.account, account, 'snapshot.account.mismatch')
    ensure(database !== snapshot.database && bucket !== snapshot.bucket, 'target.must-differ-from-source')
  })) {
    unverified('target-parity', 'Snapshot integrity failed; no target verification was attempted.')
    return finish()
  }
  const sourceObjects = [...model.objects.values()].map(({ key, size, sha256: hash }) => ({ key, size, sha256: hash }))
    .sort((a, b) => a.key.localeCompare(b.key, 'en'))
  receipt.snapshot.objectsSha256 = sha256(JSON.stringify(sourceObjects))
  Object.assign(receipt.parity.counts, {
    sourceMessages: model.messages.size, sourceAttachments: snapshot.tables.message_attachments.length,
    sourceObjects: model.objects.size, sourceBytes: sourceObjects.reduce((sum, object) => sum + object.size, 0),
    verifiedObjects: 0, verifiedBodies: 0,
  })
  let expected
  if (!await check('source-mapping', async () => { expected = await expectedMessages(snapshot) })) return finish()
  const { cf, api } = clients
  await check('worker-bindings', async () => {
    const settings = await cf.settings()
    const bindings = settings.bindings || []
    equal(bindings.find((item) => item.name === 'DB')?.id, database, 'worker.database.mismatch')
    equal(bindings.find((item) => item.name === 'MAIL_BUCKET')?.bucket_name, bucket, 'worker.bucket.mismatch')
    ensure(bindings.some((item) => item.name === 'EMAIL' && item.type === 'send_email'), 'worker.email-binding.missing')
  })
  await check('deployment-identity', async () => {
    const deployments = await cf.deployments()
    const latest = deployments.deployments?.[0]
    ensure(latest?.id && Array.isArray(latest.versions), 'worker.deployment.unavailable')
    receipt.target.deployment = { id: latest.id, createdOn: latest.created_on,
      versions: latest.versions.map(({ version_id, percentage }) => ({ id: version_id, percentage })) }
  }, false)
  await check('framing-policy', async () => {
    const response = await api('/', { anonymous: true })
    equal(response.status, 200, 'framing.page.unavailable')
    verifyFramePolicy(response.headers)
  })
  const attachmentSample = snapshot.tables.message_attachments[0]
  const deniedPaths = ['/api/messages', ...(expected[0] ? [`/api/messages/${expected[0].row.id}`] : []),
    attachmentSample ? `/api/messages/${messageId(snapshot.database, attachmentSample.message_id)}/attachments/${attachmentId(snapshot.database, attachmentSample.id)}`
      : '/api/messages/not-a-message/attachments/not-an-attachment',
    ...(expected.some((item) => item.row.raw_key) ? [`/api/messages/${expected.find((item) => item.row.raw_key).row.id}/raw`] : [])]
  await check('anonymous-access-denied', async () => {
    for (const path of deniedPaths) equal((await api(path, { anonymous: true })).status, 401, 'anonymous.resource-not-refused')
  })
  let actor
  let loggedIn = false
  try {
    const loginVerified = await check('original-password-login', async () => {
      const response = await api('/api/login', { method: 'POST', origin: base,
        json: { email: credentials.email, password: credentials.password } })
      equal(response.status, 200, 'login.original-password-not-accepted')
      loggedIn = true
      actor = (await response.json()).user
      equal(actor?.email?.toLowerCase(), credentials.email.toLowerCase(), 'login.owner.mismatch')
      const session = await api('/api/session')
      equal(session.status, 200, 'session.unavailable')
      equal((await session.json()).user?.id, actor.id, 'session.owner.mismatch')
    })
    if (!loginVerified) {
      unverified('signed-in-api-parity', 'Owner login failed; mailbox and attachment acceptance cannot be established.')
      return finish()
    }
    await check('csrf-rejected', async () => {
      for (const origin of ['https://untrusted.example', 'null']) {
        equal((await api('/api/logout', { method: 'POST', origin, json: {} })).status, 403, 'csrf.foreign-origin-not-refused')
      }
      equal((await (await api('/api/session')).json()).user?.id, actor.id, 'csrf.session-was-changed')
    })
    let users, mailboxes, messages, attachments, search, archives, draftCount
    const loaded = await check('target-data-read', async () => {
      users = await cf.query('SELECT id, email, status, deleted_at, storage_quota_bytes, storage_used_bytes FROM users WHERE lower(email) = lower(?)', [credentials.email])
      equal(users.length, 1, 'target.owner.missing-or-duplicate')
      equal(users[0].id, actor.id, 'target.owner.not-signed-in-user')
      equal(users[0].status, 'active', 'target.owner.inactive')
      equal(users[0].deleted_at, null, 'target.owner.deleted')
      mailboxes = await cf.query('SELECT mb.*, d.is_active AS domain_active FROM mailboxes mb LEFT JOIN domains d ON d.name = lower(substr(mb.address, instr(mb.address, \'@\') + 1)) WHERE mb.user_id = ?', [actor.id])
      messages = await cf.query('SELECT m.*, mb.is_hidden AS _mailbox_hidden FROM messages m JOIN mailboxes mb ON mb.address = m.mailbox_address WHERE mb.user_id = ?', [actor.id])
      attachments = await cf.query('SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id JOIN mailboxes mb ON mb.address = m.mailbox_address WHERE mb.user_id = ?', [actor.id])
      search = await cf.query('SELECT ms.* FROM message_search ms JOIN messages m ON m.id = ms.message_id JOIN mailboxes mb ON mb.address = m.mailbox_address WHERE mb.user_id = ?', [actor.id])
      draftCount = (await cf.query('SELECT COUNT(*) AS count FROM mail_drafts WHERE user_id = ?', [actor.id]))[0].count
      const prefix = `mailflare_import:${snapshot.database}:`
      archives = await cf.query('SELECT key, value FROM settings WHERE substr(key, 1, ?) = ?', [prefix.length, prefix])
    })
    if (!loaded) {
      unverified('message-parity', 'Target reads failed; no message data can be certified.')
      return finish()
    }
    receipt.parity.counts.targetMessages = messages.length
    receipt.parity.counts.targetAttachments = attachments.length
    receipt.parity.counts.importedMessages = messages.filter((item) => item.id.startsWith('mfl_')).length
    receipt.parity.counts.importedAttachments = attachments.filter((item) => item.id.startsWith('mfl_a_')).length
    await check('identity-and-mailboxes', async () => {
      const response = await api('/api/mailboxes')
      equal(response.status, 200, 'api.mailboxes.unavailable')
      const apiMailboxes = (await response.json()).mailboxes
      for (const source of model.mailboxes.values()) {
        const address = mailboxAddress(source, model.domains.get(source.domain_id))
        const stored = mailboxes.find((item) => item.address.toLowerCase() === address)
        ensure(stored && stored.is_active === 1 && stored.is_hidden === 0 && stored.domain_active === 1, 'target.mailbox.not-active-and-visible')
        ensure(apiMailboxes.some((item) => item.address === address && item.isActive && item.domainActive), 'api.mailbox.not-active-and-visible')
      }
      ensure(mailboxes.some((item) => item.address.toLowerCase() === credentials.email.toLowerCase() && item.is_primary === 1), 'target.primary-mailbox.missing')
    })
    await check('all-imported-ids-and-counts', () => {
      equal(messages.filter((item) => item.id.startsWith('mfl_')).map((item) => item.id).sort(), expected.map((item) => item.row.id).sort(), 'target.message-ids.mismatch')
      equal(attachments.filter((item) => item.id.startsWith('mfl_a_')).map((item) => item.id).sort(),
        snapshot.tables.message_attachments.map((item) => attachmentId(snapshot.database, item.id)).sort(), 'target.attachment-ids.mismatch')
      equal(archives.map((item) => item.key).sort(), expected.map((item) => archiveKey(snapshot.database, item.source.id)).sort(), 'target.archive-ids.mismatch')
    })
    for (const object of model.objects.values()) {
      await check(`object.${sha256(object.key).slice(0, 12)}`, async () => {
        const bytes = await cf.object(objectKey(snapshot.database, object.key))
        equal(bytes.length, object.size, 'target.object.size.mismatch')
        equal(sha256(bytes), object.sha256, 'target.object.hash.mismatch')
        receipt.parity.counts.verifiedObjects++
      })
    }
    const storedMessages = new Map(messages.map((item) => [item.id, item]))
    for (const item of expected) {
      const label = `message.${sha256(item.source.id).slice(0, 12)}`
      const stored = storedMessages.get(item.row.id)
      await check(`${label}.metadata`, () => {
        ensure(stored, 'target.message.missing')
        for (const [key, value] of Object.entries(item.row)) equal(stored[key], value, `target.message.${key}.mismatch`)
        const rows = attachments.filter((row) => row.message_id === item.row.id)
        equal(rows.sort((a, b) => a.id.localeCompare(b.id)), item.attachments.map((source) => expectedAttachment(snapshot, source)).sort((a, b) => a.id.localeCompare(b.id)), 'target.attachment-metadata.mismatch')
      })
      await check(`${label}.archived-metadata`, () => {
        const archive = archives.find((row) => row.key === archiveKey(snapshot.database, item.source.id))
        ensure(archive, 'target.metadata-archive.missing')
        verifyArchive(JSON.parse(archive.value), item)
      })
      await check(`${label}.body-and-storage`, async () => {
        const bytes = await cf.object(item.row.body_key)
        const body = JSON.parse(bytes.toString('utf8'))
        equal(body, item.body, 'target.message.body.mismatch')
        receipt.parity.counts.verifiedBodies++
        const rawBytes = item.source.raw_r2_key ? model.objects.get(item.source.raw_r2_key).size : 0
        const storedBytes = rawBytes + bytes.length + item.attachments.reduce((sum, row) => sum + row.size, 0)
        equal(stored?.stored_bytes, storedBytes, 'target.message.stored-bytes.mismatch')
        ensure(Number.isSafeInteger(stored?.quota_bytes) && stored.quota_bytes >= 0 && stored.quota_bytes <= storedBytes, 'target.message.quota.invalid')
        equal(search.find((row) => row.message_id === item.row.id)?.content, searchContent(item.row, item.body), 'target.search-content.mismatch')
      })
      await check(`${label}.signed-in-api`, async () => {
        const response = await api(`/api/messages/${encodeURIComponent(item.row.id)}`)
        equal(response.status, 200, 'api.message.unavailable')
        const detail = await response.json()
        ensure(stored, 'target.message.missing')
        const summary = expectedSummary(stored)
        for (const [key, value] of Object.entries(summary)) equal(detail.message?.[key], value, `api.message.${key}.mismatch`)
        equal(detail.message.text, item.body.text, 'api.message.text.mismatch')
        equal(detail.message.html, item.body.html, 'api.message.html.mismatch')
        equal(detail.message.messageId, item.row.message_id, 'api.message.message-id.mismatch')
        equal(detail.message.inReplyTo, item.row.in_reply_to, 'api.message.in-reply-to.mismatch')
        equal(detail.message.references, item.row.references_header, 'api.message.references.mismatch')
        equal(detail.message.cc, JSON.parse(item.row.cc_json), 'api.message.cc.mismatch')
        equal(detail.message.replyTo, JSON.parse(item.row.reply_to_json)[0] || item.row.sender_address, 'api.message.reply-to.mismatch')
        equal(detail.message.attachments, item.attachments.map((source) => expectedAttachment(snapshot, source)).sort((a, b) => a.id.localeCompare(b.id)).map((row) => ({
          id: row.id, filename: row.filename, contentType: row.content_type, size: row.size, contentId: row.content_id, disposition: row.disposition,
        })), 'api.attachment-metadata.mismatch')
        const peers = expected.filter((peer) => peer.source.mailbox_id === item.source.mailbox_id
          && (peer.source.id === item.source.id || item.source.thread_id && peer.source.thread_id === item.source.thread_id))
        ensure(peers.every((peer) => detail.thread?.some((entry) => entry.id === peer.row.id)), 'api.thread-members.mismatch')
        for (const attachment of item.attachments) {
          const download = await api(`/api/messages/${item.row.id}/attachments/${attachmentId(snapshot.database, attachment.id)}`)
          equal(download.status, 200, 'api.attachment.unavailable')
          equal(download.headers.get('content-type'), attachment.content_type || 'application/octet-stream', 'api.attachment.content-type.mismatch')
          const bytes = Buffer.from(await download.arrayBuffer())
          equal(bytes.length, attachment.size, 'api.attachment.size.mismatch')
          equal(sha256(bytes), model.objects.get(attachment.r2_key).sha256, 'api.attachment.hash.mismatch')
        }
        if (item.source.raw_r2_key) {
          const raw = await api(`/api/messages/${item.row.id}/raw`)
          equal(raw.status, 200, 'api.raw.unavailable')
          equal(sha256(Buffer.from(await raw.arrayBuffer())), model.objects.get(item.source.raw_r2_key).sha256, 'api.raw.hash.mismatch')
        }
      })
    }
    await check('storage-accounting', async () => {
      const draftBytes = await cf.query('SELECT COALESCE(SUM(a.size), 0) AS bytes FROM mail_draft_attachments a JOIN mail_drafts d ON d.id = a.draft_id WHERE d.user_id = ?', [actor.id])
      equal(users[0].storage_used_bytes, messages.reduce((sum, row) => sum + row.quota_bytes, 0) + draftBytes[0].bytes, 'target.owner.storage-used.mismatch')
      ensure(users[0].storage_quota_bytes === 0 || users[0].storage_quota_bytes >= users[0].storage_used_bytes, 'target.owner.storage-quota.exceeded')
    })
    const visibleMessages = messages.filter((row) => !row._mailbox_hidden || row.mailbox_address === '__unassigned__@omnimail.invalid')
    const counts = {
      unread: visibleMessages.filter((row) => row.direction === 'incoming' && row.folder === 'inbox' && row.is_read === 0).length,
      starred: visibleMessages.filter((row) => row.is_starred === 1 && row.folder !== 'trash').length,
      sent: visibleMessages.filter((row) => row.direction === 'outgoing' && row.folder === 'sent').length,
      trash: visibleMessages.filter((row) => row.folder === 'trash').length, drafts: draftCount,
    }
    const list = async (folder, query) => {
      const items = [], cursors = new Set()
      let cursor
      do {
        const params = new URLSearchParams({ folder, limit: '100', ...(query ? { q: query } : {}), ...(cursor ? { cursor } : {}) })
        const response = await api(`/api/messages?${params}`)
        equal(response.status, 200, 'api.message-list.unavailable')
        const page = await response.json()
        ensure(Array.isArray(page.messages) && typeof page.page?.hasMore === 'boolean', 'api.message-list.invalid')
        equal(page.counts, counts, 'api.message-counts.mismatch')
        items.push(...page.messages)
        cursor = page.page.hasMore ? page.page.nextCursor : null
        ensure(!page.page.hasMore || typeof cursor === 'string' && cursor && !cursors.has(cursor), 'api.message-list.cursor.invalid')
        if (cursor) cursors.add(cursor)
        ensure(items.length <= messages.length, 'api.message-list.duplicate-or-inconsistent')
      } while (cursor)
      return items
    }
    await check('folders-and-pagination', async () => {
      for (const folder of ['inbox', 'sent', 'trash', 'starred']) {
        const listed = await list(folder)
        const visible = visibleMessages
          .filter((row) => folder === 'starred' ? row.is_starred === 1 && row.folder !== 'trash'
            : folder === 'trash' ? row.folder === 'trash' : row.folder === folder && row.direction === (folder === 'inbox' ? 'incoming' : 'outgoing'))
        equal(listed.map((row) => row.id).sort(), visible.map((row) => row.id).sort(), 'api.folder-message-ids.mismatch')
        for (const entry of listed) equal(entry, expectedSummary(storedMessages.get(entry.id)), 'api.folder-message-metadata.mismatch')
      }
    })
    await check('body-search', async () => {
      for (const item of expected) {
        const token = item.body.text.match(/[\p{L}\p{N}]{4,40}/u)?.[0]?.toLowerCase()
        if (!token) continue
        const results = await list(item.row.folder, token)
        ensure(results.some((row) => row.id === item.row.id), 'api.body-search.message-missing')
      }
    })
    receipt.parity.hashes = {
      nativeMetadataSha256: sha256(stableJson(expected.map((item) => item.row).sort((a, b) => a.id.localeCompare(b.id)))),
      bodyManifestSha256: sha256(stableJson(expected.map((item) => ({ id: item.row.id, sha256: sha256(stableJson(item.body)) })).sort((a, b) => a.id.localeCompare(b.id)))),
      archivedMetadataSha256: sha256(stableJson(expected.map((item) => ({ source: item.source.id, sha256: sha256(stableJson(item.source)) })).sort((a, b) => a.source.localeCompare(b.source)))),
    }
  } finally {
    if (loggedIn) await check('owned-session-cleanup', async () => {
      equal((await api('/api/logout', { method: 'POST', origin: base, json: {} })).status, 200, 'session.logout.failed')
      equal((await (await api('/api/session')).json()).user, null, 'session.logout.still-active')
    })
  }
  return finish()
}

export function cliOptions(args) {
  const { values } = parseArgs({ args, options: Object.fromEntries(
    ['base', 'snapshot', 'account', 'database', 'bucket', 'credentials', 'receipt'].map((name) => [name, { type: 'string' }]),
  ) })
  for (const name of ['base', 'snapshot', 'account', 'database', 'bucket', 'receipt']) ensure(values[name], `arguments.${name}.required`)
  const url = new URL(values.base)
  ensure(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'arguments.base.must-be-https-origin')
  ensure(/^[a-f0-9]{32}$/i.test(values.account), 'arguments.account.invalid')
  ensure(/^[a-f0-9-]{36}$/i.test(values.database), 'arguments.database.invalid')
  ensure(/^[a-z0-9][a-z0-9-]{1,62}$/.test(values.bucket), 'arguments.bucket.invalid')
  return { ...values, base: url.origin, credentials: values.credentials || join(homedir(), '.mailflare', 'apehost.dev.json') }
}

async function main() {
  const options = cliOptions(process.argv.slice(2))
  const snapshotBytes = readFileSync(options.snapshot)
  const snapshot = JSON.parse(snapshotBytes.toString('utf8').replace(/^\uFEFF/, ''))
  const credentials = readJson(options.credentials)
  ensure(typeof credentials.email === 'string' && typeof credentials.password === 'string' && credentials.password, 'credentials.email-and-password.required')
  try {
    execFileSync('rtk', ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(homedir(), '.cloudflare-oauth', 'cf-oauth-login.ps1')], { stdio: 'ignore' })
  } catch { throw new Error('cloudflare.oauth-helper.failed') }
  const { access_token: token } = readJson(join(homedir(), '.cloudflare-oauth', 'tokens.json'))
  ensure(typeof token === 'string' && token, 'cloudflare.oauth.required')
  const revision = execFileSync('rtk', ['git', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const receipt = await verifyImport({ ...options, snapshot, snapshotBytes, credentials, revision }, {
    cf: cloudflareReader(options.account, options.database, options.bucket, token),
    api: apiReader(options.base),
  })
  mkdirSync(dirname(resolve(options.receipt)), { recursive: true, mode: 0o700 })
  writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ status: receipt.status, parity: receipt.parity.verified,
    counts: receipt.parity.counts, failed: receipt.parity.checks.filter((item) => item.status !== 'PASSED').map(({ id, status, reason }) => ({ id, status, reason })),
    receipt: resolve(options.receipt), remainingAcceptance: receipt.remainingAcceptance.map((item) => item.id) }))
  if (!receipt.parity.verified) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(safeError(error)); process.exitCode = 1 })
}
