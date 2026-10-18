import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { hashPassword, validatePassword, verifyPassword } from '../email-worker/src/features/auth/session/auth.ts'
import { check, planSnapshot, sha256 } from './mailflare-snapshot.mjs'

const same = (actual, expected) => actual && Object.entries(expected).every(([key, value]) => actual[key] === value)
const statement = (sql, params = []) => ({ sql, params })
const insert = (table, row) => statement(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row))
const stateFields = new Set(['status', 'folder', 'is_read', 'is_starred', 'trashed_at', 'delivery_status', 'updated_at'])

// A failed guard aborts the D1 batch, including its quota and manifest writes.
function guard(sql, params = []) {
  return statement(`SELECT CASE WHEN (${sql}) THEN 1 ELSE json('mailflare_import_conflict') END AS import_guard`, params)
}

function rowGuard(table, key, previous) {
  if (!previous) return guard(`SELECT COUNT(*) = 0 FROM ${table} WHERE ${Object.keys(key).map((column) => `${column} IS ?`).join(' AND ')}`, Object.values(key))
  return guard(`SELECT COUNT(*) = 1 FROM ${table} WHERE ${Object.keys(previous).map((column) => `${column} IS ?`).join(' AND ')}`, Object.values(previous))
}

async function readMessage(client, id) {
  const row = (await client.query('SELECT * FROM messages WHERE id = ?', [id]))[0]
  const attachments = await client.query('SELECT * FROM attachments WHERE message_id = ? ORDER BY id', [id])
  return { row, attachments }
}

async function accountedBytes(client, userId) {
  const [{ expected }] = await client.query(`SELECT
    COALESCE((SELECT SUM(m.quota_bytes) FROM messages m JOIN mailboxes mb ON mb.address = m.mailbox_address WHERE mb.user_id = ?), 0)
    + COALESCE((SELECT SUM(a.size) FROM mail_draft_attachments a JOIN mail_drafts d ON d.id = a.draft_id WHERE d.user_id = ?), 0) AS expected`, [userId, userId])
  return expected
}

function checkAttachments(actual, expected) {
  check(actual.length === expected.length && expected.every((row) => actual.some((item) => same(item, row))), 'Destination attachment metadata conflict')
}

async function preflight(plan, credentials, client) {
  check(!validatePassword(credentials.password), 'Credential password does not meet OmniMail requirements')
  await client.query('SELECT quota_bytes, stored_bytes, reply_to_json, delivered_to, purge_after FROM messages LIMIT 0')
  await client.query('SELECT cleanup_job_id FROM mailboxes LIMIT 0')
  const owner = (await client.query('SELECT * FROM users WHERE email = ?', [plan.email]))[0]
  const setup = (await client.query("SELECT value FROM settings WHERE key = 'setup_complete'"))[0]
  if (owner) {
    check(owner.role === 'super_admin' && owner.status === 'active' && owner.deleted_at === null && owner.can_reply === 1, 'Destination owner is not an active super administrator')
    check(setup?.value === '1', 'Destination owner setup is incomplete')
    check(await verifyPassword(credentials.password, owner.password_hash), 'Destination owner password conflicts with source credentials')
    check(owner.storage_used_bytes === await accountedBytes(client, owner.id), 'Destination quota accounting conflicts before import')
  } else {
    const [{ count }] = await client.query('SELECT COUNT(*) AS count FROM users')
    check(count === 0 && !setup, 'Destination already has a different owner')
  }
  const userId = owner?.id || `mfl_user_${sha256(`${plan.snapshot.account}:${plan.email}`).slice(0, 32)}`
  const bootstrap = []
  if (!owner) {
    bootstrap.push(guard('SELECT COUNT(*) = 0 FROM users'), rowGuard('settings', { key: 'setup_complete' }, null))
    bootstrap.push(insert('users', {
      id: userId, email: plan.email, display_name: (plan.primary.source.display_name || plan.email).slice(0, 60),
      password_hash: await hashPassword(credentials.password), role: 'super_admin', mailbox_limit: 100,
      can_create_mailboxes: 1, can_reply: 1, storage_quota_bytes: 5368709120,
    }), insert('settings', { key: 'setup_complete', value: '1' }))
  }
  const domainNames = [...new Set(plan.mailboxes.map((mailbox) => mailbox.domain.hostname.toLowerCase()))]
  for (const name of domainNames) {
    const row = (await client.query('SELECT * FROM domains WHERE name = ?', [name]))[0]
    check(!row || row.is_active === 1, 'Destination domain is inactive')
    if (!row) bootstrap.push(insert('domains', { name, is_active: 1, created_by: userId }))
  }
  for (const mailbox of plan.mailboxes) {
    const row = (await client.query('SELECT * FROM mailboxes WHERE address = ?', [mailbox.address]))[0]
    const expected = {
      address: mailbox.address, user_id: userId, is_primary: Number(mailbox.address === plan.email), is_active: 1, is_hidden: 0,
    }
    check(!row || same(row, expected) && row.cleanup_job_id === null, 'Destination mailbox ownership or state conflicts')
    if (!row) bootstrap.push(insert('mailboxes', { ...expected, created_at: mailbox.created_at }))
  }
  const changes = []
  let delta = 0
  for (const message of plan.messages) {
    const previousSetting = (await client.query('SELECT value FROM settings WHERE key = ?', [message.metadataKey]))[0]
    let previous
    try { previous = previousSetting ? JSON.parse(previousSetting.value) : null } catch { throw new Error('Invalid destination import metadata') }
    const current = await readMessage(client, message.row.id)
    check(Boolean(previous) === Boolean(current.row), 'Destination message exists without matching import provenance')
    if (previous) {
      check(previous.version === 1 && same(current.row, previous.row), 'Destination message was changed after import')
      check(Date.parse(plan.snapshot.createdAt) >= Date.parse(previous.snapshotCreatedAt), 'Refusing an older source snapshot')
      checkAttachments(current.attachments, previous.attachmentRows)
      for (const [key, value] of Object.entries(message.row)) {
        check(stateFields.has(key) || previous.row[key] === value, 'Source message content changed; refusing to overwrite imported content')
      }
      checkAttachments(current.attachments, message.attachmentRows)
      const search = (await client.query('SELECT content FROM message_search WHERE message_id = ?', [message.row.id]))[0]
      check(search?.content === message.content, 'Destination search content conflict')
    } else {
      check(current.attachments.length === 0, 'Destination has orphan imported attachments')
      const collision = await client.query('SELECT id FROM messages WHERE mailbox_address = ? AND message_id = ?', [message.row.mailbox_address, message.row.message_id])
      check(collision.length === 0, 'Destination already contains this Message-ID')
      for (const attachment of message.attachmentRows) {
        check((await client.query('SELECT id FROM attachments WHERE id = ? OR r2_key = ?', [attachment.id, attachment.r2_key])).length === 0, 'Destination attachment ID or object is already in use')
      }
    }
    delta += message.row.quota_bytes - (previous?.row.quota_bytes || 0)
    changes.push({ message, previous, previousSetting })
  }
  check(!owner || owner.storage_quota_bytes === 0 || owner.storage_used_bytes + delta <= owner.storage_quota_bytes, 'Import exceeds destination storage quota')
  const missingObjects = []
  const objectKeys = new Set(plan.objects.map(({ key }) => key))
  for (const { object_key } of await client.query('SELECT object_key FROM pending_object_deletions')) {
    check(!objectKeys.has(object_key), 'An import object is pending deletion')
  }
  for (const object of plan.objects) {
    const actual = await client.getObject(object.key)
    if (actual === null) missingObjects.push(object)
    else check(actual.length === object.size && sha256(actual) === object.sha256, 'Destination object integrity conflict')
  }
  return { userId, bootstrap, changes, missingObjects, delta }
}

async function verifyDestination(plan, credentials, client, userId) {
  const owner = (await client.query('SELECT * FROM users WHERE id = ?', [userId]))[0]
  check(owner?.email === plan.email && owner.role === 'super_admin' && owner.status === 'active' && owner.deleted_at === null
    && await verifyPassword(credentials.password, owner.password_hash), 'Destination owner/password verification failed')
  for (const mailbox of plan.mailboxes) {
    const row = (await client.query('SELECT * FROM mailboxes WHERE address = ?', [mailbox.address]))[0]
    check(row?.user_id === userId && row.is_active === 1 && row.is_hidden === 0 && !row.cleanup_job_id, 'Destination mailbox verification failed')
    const domain = (await client.query('SELECT is_active FROM domains WHERE name = ?', [mailbox.domain.hostname.toLowerCase()]))[0]
    check(domain?.is_active === 1, 'Destination domain verification failed')
  }
  for (const message of plan.messages) {
    const current = await readMessage(client, message.row.id)
    check(same(current.row, message.row), 'Destination message verification failed')
    checkAttachments(current.attachments, message.attachmentRows)
    const metadata = (await client.query('SELECT value FROM settings WHERE key = ?', [message.metadataKey]))[0]
    check(metadata?.value === JSON.stringify(message.metadata), 'Destination source metadata verification failed')
    const search = (await client.query('SELECT content FROM message_search WHERE message_id = ?', [message.row.id]))[0]
    check(search?.content === message.content, 'Destination search verification failed')
  }
  for (const object of plan.objects) {
    const actual = await client.getObject(object.key)
    check(actual !== null && actual.length === object.size && sha256(actual) === object.sha256, 'Destination object read-back verification failed')
  }
  check(owner.storage_used_bytes === await accountedBytes(client, userId), 'Destination quota accounting verification failed')
  const state = (await client.query('SELECT version FROM mail_state_versions WHERE user_id = ?', [userId]))[0]
  check(!plan.messages.length || state?.version > 0, 'Destination mail state verification failed')
}

export async function migrateMailflare({ snapshot, credentials, target, client, execute = false, snapshotHash, snapshotPath = null }) {
  const plan = await planSnapshot(snapshot, credentials, target, snapshotHash)
  const prepared = await preflight(plan, credentials, client)
  if (execute) {
    for (const object of prepared.missingObjects) {
      await client.putObject(object.key, object.bytes, object.contentType)
      const actual = await client.getObject(object.key)
      check(actual !== null && actual.length === object.size && sha256(actual) === object.sha256, 'Destination uploaded object verification failed')
    }
    if (prepared.bootstrap.length) await client.batch(prepared.bootstrap)
    for (const { message, previous, previousSetting } of prepared.changes) {
      const statements = [rowGuard('messages', { id: message.row.id }, previous?.row),
        rowGuard('settings', { key: message.metadataKey }, previousSetting ? { key: message.metadataKey, value: previousSetting.value } : null)]
      statements.push(guard(`SELECT COUNT(*) = 1 FROM mailboxes mb JOIN users u ON u.id = mb.user_id
        WHERE mb.address = ? AND mb.user_id = ? AND mb.is_active = 1 AND mb.is_hidden = 0 AND mb.cleanup_job_id IS NULL
        AND u.status = 'active' AND u.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM domains WHERE name = ? AND is_active = 1)`,
      [message.row.mailbox_address, prepared.userId, message.mailbox.domain.hostname.toLowerCase()]))
      if (!previous) {
        statements.push(guard(`SELECT COUNT(*) = 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL
          AND (storage_quota_bytes = 0 OR storage_used_bytes + ? <= storage_quota_bytes)`, [prepared.userId, message.row.quota_bytes]))
        statements.push(insert('messages', message.row), ...message.attachmentRows.map((row) => insert('attachments', row)))
        statements.push(insert('message_search', { message_id: message.row.id, content: message.content }))
        statements.push(statement('UPDATE users SET storage_used_bytes = storage_used_bytes + ? WHERE id = ?', [message.row.quota_bytes, prepared.userId]))
      } else {
        const changed = Object.keys(message.row).filter((key) => message.row[key] !== previous.row[key])
        if (changed.length) statements.push(statement(`UPDATE messages SET ${changed.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`, [...changed.map((key) => message.row[key]), message.row.id]))
      }
      statements.push(statement(`INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
        WHERE settings.value IS NOT excluded.value`, [message.metadataKey, JSON.stringify(message.metadata)]))
      await client.batch(statements)
    }
    await verifyDestination(plan, credentials, client, prepared.userId)
  }
  return {
    formatVersion: 1, mode: execute ? 'executed' : 'dry-run', verified: execute, sourceIntegrityVerified: true,
    snapshot: {
      path: snapshotPath, sha256: plan.snapshotHash, createdAt: snapshot.createdAt, account: snapshot.account,
      database: snapshot.database, bucket: snapshot.bucket, ...(snapshot.bookmark ? { bookmark: snapshot.bookmark } : {}),
      objectManifestSha256: plan.objectManifestSha256,
    },
    target, counts: {
      messages: plan.messages.length, attachments: snapshot.tables.message_attachments.length,
      sourceObjects: snapshot.objects.length, bodyObjects: plan.messages.length, objects: plan.objects.length,
      quotaBytes: plan.messages.reduce((total, { row }) => total + row.quota_bytes, 0),
      storedBytes: plan.messages.reduce((total, { row }) => total + row.stored_bytes, 0),
      newMessages: prepared.changes.filter(({ previous }) => !previous).length,
      missingObjects: prepared.missingObjects.length,
    }, verifiedAt: execute ? new Date().toISOString() : null,
  }
}

export function cloudflareClient(target, token, fetcher = fetch) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${target.account}`
  async function request(path, init = {}, allowMissing = false) {
    let response
    try {
      response = await fetcher(`${base}${path}`, {
        ...init, redirect: 'error', headers: { ...init.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      })
    } catch { throw new Error('Cloudflare request failed; rerun to reconcile completed writes') }
    if (allowMissing && response.status === 404) return null
    check(response.ok, `Cloudflare request failed: HTTP ${response.status}`)
    return response
  }
  async function d1(body) {
    const response = await request(`/d1/database/${target.database}/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const result = await response.json()
    check(result.success && Array.isArray(result.result) && result.result.every((item) => item.success), 'Cloudflare D1 query failed')
    return result.result
  }
  return {
    query: async (sql, params = []) => (await d1({ sql, params }))[0].results,
    batch: async (batch) => {
      const result = await d1({ batch })
      check(result.length === batch.length, 'Cloudflare D1 batch result count mismatch')
      return result
    },
    getObject: async (key) => {
      const response = await request(`/r2/buckets/${target.bucket}/objects/${encodeURIComponent(key)}`, {}, true)
      return response ? Buffer.from(await response.arrayBuffer()) : null
    },
    putObject: async (key, bytes, contentType) => {
      // Import keys are deterministic; an existing object is always verified before reuse.
      const existing = await request(`/r2/buckets/${target.bucket}/objects/${encodeURIComponent(key)}`, {}, true)
      if (existing) {
        check(sha256(Buffer.from(await existing.arrayBuffer())) === sha256(bytes), 'Destination object appeared with conflicting bytes')
        return
      }
      await request(`/r2/buckets/${target.bucket}/objects/${encodeURIComponent(key)}`, {
        method: 'PUT', headers: { 'Content-Type': contentType, 'If-None-Match': '*' }, body: bytes,
      })
    },
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    snapshot: { type: 'string' }, account: { type: 'string' }, database: { type: 'string' },
    bucket: { type: 'string' }, credentials: { type: 'string' }, execute: { type: 'boolean', default: false },
    receipt: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('Node >=24: node scripts/migrate-mailflare.mjs --snapshot <file> --account <id> --database <destination-uuid> --bucket <destination> --credentials <private-json> [--execute] [--receipt <new-file>]')
    return
  }
  for (const key of ['snapshot', 'account', 'database', 'bucket', 'credentials']) check(values[key], `Missing --${key}`)
  const snapshotBytes = readFileSync(values.snapshot)
  const snapshot = JSON.parse(snapshotBytes.toString('utf8').replace(/^\uFEFF/, ''))
  const credentials = JSON.parse(readFileSync(values.credentials, 'utf8').replace(/^\uFEFF/, ''))
  const target = { account: values.account, database: values.database, bucket: values.bucket }
  // Validate all source bytes before even opening the OAuth session or destination.
  await planSnapshot(snapshot, credentials, target, sha256(snapshotBytes))
  let token
  try { token = JSON.parse(readFileSync(join(homedir(), '.cloudflare-oauth/tokens.json'), 'utf8').replace(/^\uFEFF/, '')).access_token } catch { throw new Error('Unable to read local Cloudflare OAuth session; run the OAuth helper first') }
  check(typeof token === 'string' && token, 'Run the Cloudflare OAuth helper first')
  const receipt = await migrateMailflare({ snapshot, credentials, target, client: cloudflareClient(target, token), execute: values.execute, snapshotHash: sha256(snapshotBytes), snapshotPath: resolve(values.snapshot) })
  const output = `${JSON.stringify(receipt, null, 2)}\n`
  if (values.receipt) writeFileSync(values.receipt, output, { flag: 'wx', mode: 0o600 })
  console.log(output.trimEnd())
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    // Never print request bodies, password hashes, source mail or Cloudflare response bodies.
    console.error(error instanceof SyntaxError ? 'Invalid JSON input or Cloudflare response' : error.message)
    process.exitCode = 1
  })
}
