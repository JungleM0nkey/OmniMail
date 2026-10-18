import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, it } from 'vitest'
import { hashPassword, verifyPassword } from '../email-worker/src/features/auth/session/auth'
import { cloudflareClient, migrateMailflare } from './migrate-mailflare.mjs'
import { SOURCE_DATABASE, SOURCE_BUCKET, messageId, metadataKey, objectKey, planSnapshot, sha256 } from './mailflare-snapshot.mjs'

const target = { account: 'a'.repeat(32), database: '11111111-1111-4111-8111-111111111111', bucket: 'omni-mail-storage' }
const credentials = { email: 'owner@example.test', password: 'fixture-password-only' }
const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

function fixture() {
  const raw = Buffer.from('From: "Sender, Example" <outside@example.test>\r\nTo: Owner <owner@example.test>\r\nDate: Wed, 16 Oct 2024 12:00:00 +0000\r\nMessage-ID: <same@example.test>\r\nSubject: Fixture\r\n\r\nraw body\r\n')
  const attachment = Buffer.from([0, 255, 17, 0, 128])
  const makeObject = (key: string, bytes: Buffer) => ({ key, size: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') })
  const common = {
    user_id: 'source-owner', mailbox_id: 'source-mailbox', provider_message_id: '<same@example.test>',
    from_addr: 'Owner <owner@example.test>', to_addr: '"Recipient, Example" <outside@example.test>',
    subject: 'Fixture <subject>', snippet: 'Source preview', created_at: 1_730_000_000,
    thread_id: 'shared-source-thread', read: 0, starred: 0, folder_id: null, snoozed_until: null,
    text_body: 'Exact text\nwith Unicode ☃', html_body: '<p>Exact <b>html</b> ☃</p>', raw_r2_key: null,
    cc_addr: 'Other <cc@example.test>', bcc_addr: 'Secret <bcc@example.test>',
    reply_to: 'Replies <reply@example.test>', in_reply_to: 'parent@example.test', references_header: '<root@example.test> parent@example.test',
    spam_verdict: null, spam_signals: null, trashed_at: null,
  }
  const snapshot = {
    createdAt: '2026-10-18T12:00:00Z', account: target.account, database: SOURCE_DATABASE, bucket: SOURCE_BUCKET,
    tables: {
      messages: [
        { ...common, id: 'sent', direction: 'outbound', status: 'sent', read: 1, html_body: null },
        { ...common, id: 'received', direction: 'inbound', status: 'received', raw_r2_key: 'inbound/raw.eml', from_addr: '"Sender, Example" <outside@example.test>', to_addr: 'Owner <owner@example.test>' },
      ],
      message_attachments: [
        { id: 'attachment-in', message_id: 'received', filename: 'inline.bin', content_type: 'application/octet-stream', size: attachment.length, r2_key: 'attachments/in', content_id: 'cid-inline', disposition: 'inline', created_at: common.created_at, trashed_at: null },
        { id: 'attachment-out', message_id: 'sent', filename: 'out.bin', content_type: 'application/octet-stream', size: attachment.length, r2_key: 'attachments/out', content_id: null, disposition: 'attachment', created_at: common.created_at, trashed_at: null },
      ],
      mailboxes: [{ id: 'source-mailbox', user_id: 'source-owner', domain_id: 'source-domain', local_part: 'owner', display_name: 'Owner', created_at: common.created_at, disabled: 0 }],
      domains: [{ id: 'source-domain', user_id: 'source-owner', hostname: 'example.test', created_at: common.created_at }],
    },
    objects: [makeObject('inbound/raw.eml', raw), makeObject('attachments/in', attachment), makeObject('attachments/out', attachment)],
  }
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const migrations = new URL('../migrations/', import.meta.url)
  for (const name of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'))
  const objects = new Map<string, Buffer>()
  let writes = 0
  let queries = 0
  let failAfterMessageCommit = false
  let corruptUpload = false
  const client = {
    async query(sql: string, params: unknown[] = []) { queries++; return db.prepare(sql).all(...params as never[]) },
    async batch(batch: Array<{ sql: string; params: unknown[] }>) {
      writes++
      db.exec('BEGIN')
      try {
        const result = batch.map(({ sql, params }) => ({ success: true, results: db.prepare(sql).all(...params as never[]) }))
        db.exec('COMMIT')
        if (failAfterMessageCommit && batch.some(({ sql }) => sql.startsWith('INSERT INTO messages'))) {
          failAfterMessageCommit = false
          throw new Error('Ambiguous committed response')
        }
        return result
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* The ambiguous-response fixture already committed. */ }
        throw error
      }
    },
    async getObject(key: string) { return objects.get(key) ?? null },
    async putObject(key: string, bytes: Buffer) { writes++; objects.set(key, corruptUpload ? Buffer.from('corrupt') : Buffer.from(bytes)) },
  }
  const run = (execute = true) => migrateMailflare({ snapshot, credentials, target, client, execute })
  return { snapshot, db, client, objects, run, writes: () => writes, queries: () => queries, failCommit: () => { failAfterMessageCommit = true }, corrupt: () => { corruptUpload = true } }
}

describe('Mailflare import with real OmniMail migrations and mocked Cloudflare storage', () => {
  it('defaults to read-only planning and verifies all source bytes before destination access', async () => {
    const f = fixture()
    const receipt = await f.run(false)
    assert.equal(receipt.mode, 'dry-run')
    assert.equal(receipt.verified, false)
    assert.equal(f.writes(), 0)
    assert.equal(f.objects.size, 0)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count, 0)
    f.snapshot.objects[0].sha256 = '0'.repeat(64)
    const before = f.queries()
    await assert.rejects(f.run(), /Source object integrity mismatch/)
    assert.equal(f.queries(), before)
    assert.equal(f.writes(), 0)
  })

  it('preserves both self-send copies, exact bodies, raw/attachment bytes, metadata, search and counters on repeated import', async () => {
    const f = fixture()
    const first = await f.run()
    const version = f.db.prepare('SELECT version FROM mail_state_versions').get()?.version
    const usage = f.db.prepare('SELECT storage_used_bytes FROM users').get()?.storage_used_bytes
    const second = await f.run()
    assert.equal(first.verified, true)
    assert.equal(second.counts.newMessages, 0)
    assert.equal(second.counts.missingObjects, 0)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count, 2)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM attachments').get()?.count, 2)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM message_search').get()?.count, 2)
    assert.equal(f.db.prepare('SELECT version FROM mail_state_versions').get()?.version, version)
    assert.equal(f.db.prepare('SELECT storage_used_bytes FROM users').get()?.storage_used_bytes, usage)
    assert.equal(usage, first.counts.quotaBytes)
    assert.equal(f.db.prepare('SELECT SUM(stored_bytes) AS bytes FROM messages').get()?.bytes, [...f.objects.values()].reduce((sum, bytes) => sum + bytes.length, 0))
    const owner = f.db.prepare('SELECT password_hash FROM users').get()!
    assert.equal(await verifyPassword(credentials.password, String(owner.password_hash)), true)
    assert.equal(await verifyPassword('wrong-fixture-password', String(owner.password_hash)), false)
    const rows = f.db.prepare('SELECT * FROM messages ORDER BY direction').all()
    assert.equal(rows[0].message_id, '<same@example.test>')
    assert.notEqual(rows[0].message_id, rows[1].message_id)
    assert.ok(String(rows[1].references_header).includes('<same@example.test>'))
    const marker = `<mfl-thread-${sha256(`${SOURCE_DATABASE}:shared-source-thread`).slice(0, 32)}@mailflare.invalid>`
    assert.ok(rows.every((row) => String(row.references_header).includes(marker)))
    assert.equal(rows[0].received_at, Math.floor(Date.parse('2024-10-16T12:00:00Z') / 1000))
    assert.equal(rows[0].sender_name, 'Sender, Example')
    assert.equal(rows[0].reply_to_json, '["reply@example.test"]')
    for (const source of f.snapshot.tables.messages) {
      const id = messageId(SOURCE_DATABASE, source.id)
      const row = f.db.prepare('SELECT * FROM messages WHERE id = ?').get(id)!
      const body = f.objects.get(String(row.body_key))!
      assert.deepEqual(JSON.parse(body.toString()), { text: source.text_body, html: source.html_body ?? '' })
      const setting = f.db.prepare('SELECT value FROM settings WHERE key = ?').get(metadataKey(SOURCE_DATABASE, source.id))!
      const metadata = JSON.parse(String(setting.value))
      const { text_body, html_body, ...sourceMetadata } = source
      assert.deepEqual(metadata.source, sourceMetadata)
      assert.deepEqual(metadata.bodyNulls, { text: text_body == null, html: html_body == null })
      assert.ok(String(f.db.prepare('SELECT content FROM message_search WHERE message_id = ?').get(id)?.content).includes('exact text with unicode ☃'))
    }
    for (const object of f.snapshot.objects) assert.equal(sha256(f.objects.get(objectKey(SOURCE_DATABASE, object.key))), object.sha256)
  })

  it('refreshes source read/starred/trash state without duplicating usage or objects', async () => {
    const f = fixture()
    await f.run()
    const usage = f.db.prepare('SELECT storage_used_bytes FROM users').get()?.storage_used_bytes
    const version = Number(f.db.prepare('SELECT version FROM mail_state_versions').get()?.version)
    const count = f.objects.size
    const source = f.snapshot.tables.messages[1]
    source.read = 1
    source.starred = 1
    source.status = 'trash'
    source.trashed_at = 1_730_000_100 as never
    f.snapshot.createdAt = '2026-10-18T12:01:00Z'
    await f.run()
    const row = f.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId(SOURCE_DATABASE, source.id))!
    assert.equal(row.is_read, 1)
    assert.equal(row.is_starred, 1)
    assert.equal(row.folder, 'trash')
    assert.equal(row.trashed_at, source.trashed_at)
    assert.equal(row.purge_after, null)
    assert.equal(f.db.prepare('SELECT storage_used_bytes FROM users').get()?.storage_used_bytes, usage)
    assert.equal(Number(f.db.prepare('SELECT version FROM mail_state_versions').get()?.version), version + 1)
    assert.equal(f.objects.size, count)
  })

  it('resumes after an ambiguous committed response without double-counting', async () => {
    const f = fixture()
    f.failCommit()
    await assert.rejects(f.run(), /Ambiguous committed response/)
    const receipt = await f.run()
    assert.equal(receipt.counts.newMessages, 1)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count, 2)
    assert.equal(f.db.prepare('SELECT storage_used_bytes FROM users').get()?.storage_used_bytes, receipt.counts.quotaBytes)
  })

  it('reuses an initialized staged owner and preserves unrelated quota use', async () => {
    const f = fixture()
    f.db.prepare('INSERT INTO users (id,email,display_name,password_hash,role,can_reply) VALUES (?,?,?,?,?,1)')
      .run('staged', credentials.email, 'Staged owner', await hashPassword(credentials.password), 'super_admin')
    f.db.exec("INSERT INTO settings (key,value) VALUES ('setup_complete','1')")
    f.db.exec(`INSERT INTO mailboxes (address,user_id) VALUES ('other@example.test','staged');
      INSERT INTO messages (id,mailbox_address,direction,status,folder,sender_address,quota_bytes)
        VALUES ('other','other@example.test','incoming','ready','inbox','sender@example.test',123);
      INSERT INTO mail_drafts (id,user_id,mailbox_address,created_at,updated_at)
        VALUES ('other-draft','staged','other@example.test',1,1);
      INSERT INTO mail_draft_attachments (id,draft_id,filename,content_type,size,r2_key,created_at)
        VALUES ('other-attachment','other-draft','draft.bin','application/octet-stream',7,'unrelated-draft',1);
      UPDATE users SET storage_used_bytes = 130 WHERE id = 'staged'`)
    const receipt = await f.run()
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count, 1)
    assert.equal(f.db.prepare('SELECT user_id FROM mailboxes').get()?.user_id, 'staged')
    assert.equal(f.db.prepare('SELECT storage_used_bytes FROM users').get()?.storage_used_bytes, receipt.counts.quotaBytes + 130)
  })

  it('refuses source targets, corrupt uploads, stale snapshots and conflicting target bytes/rows/passwords', async () => {
    const sourceTarget = fixture()
    await assert.rejects(migrateMailflare({ snapshot: sourceTarget.snapshot, credentials, target: { ...target, database: SOURCE_DATABASE }, client: sourceTarget.client, execute: true }), /Refusing to write into Mailflare/)
    assert.equal(sourceTarget.writes(), 0)
    const corrupt = fixture()
    corrupt.corrupt()
    await assert.rejects(corrupt.run(), /uploaded object verification/)
    assert.equal(corrupt.db.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count, 0)
    const conflicting = fixture()
    await conflicting.run()
    conflicting.objects.set([...conflicting.objects.keys()][0], Buffer.from('tampered'))
    const writes = conflicting.writes()
    await assert.rejects(conflicting.run(), /Destination object integrity conflict/)
    assert.equal(conflicting.writes(), writes)
    const changed = fixture()
    await changed.run()
    changed.db.exec("UPDATE messages SET subject = 'locally changed'")
    await assert.rejects(changed.run(), /Destination message was changed/)
    const stale = fixture()
    await stale.run()
    stale.snapshot.createdAt = '2026-10-17T12:00:00Z'
    await assert.rejects(stale.run(), /older source snapshot/)
    const password = fixture()
    await password.run()
    password.db.prepare('UPDATE users SET password_hash = ?').run(await hashPassword('different-fixture-password'))
    await assert.rejects(password.run(), /password conflicts/)
  })

  it('rejects orphan/missing objects, unknown states and unsupported custom folders before writing', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.snapshot.objects.pop() },
      (f: ReturnType<typeof fixture>) => { f.snapshot.tables.message_attachments[0].message_id = 'missing' },
      (f: ReturnType<typeof fixture>) => { f.snapshot.tables.messages[0].status = 'queued' },
      (f: ReturnType<typeof fixture>) => { f.snapshot.tables.messages[0].folder_id = 'custom' as never },
    ]) {
      const f = fixture()
      mutate(f)
      await assert.rejects(f.run())
      assert.equal(f.writes(), 0)
      assert.equal(f.queries(), 0)
    }
  })

  it('refuses accounting drift and atomically guards mailbox ownership during a concurrent change', async () => {
    const drift = fixture()
    await drift.run()
    drift.db.exec('UPDATE users SET storage_used_bytes = storage_used_bytes + 1')
    const writes = drift.writes()
    await assert.rejects(drift.run(), /quota accounting conflicts before import/)
    assert.equal(drift.writes(), writes)
    const concurrent = fixture()
    const batch = concurrent.client.batch
    concurrent.client.batch = async (statements) => {
      if (statements.some(({ sql }) => sql.startsWith('INSERT INTO messages'))) {
        concurrent.db.exec(`INSERT INTO users (id,email,display_name,password_hash) VALUES ('other','other@example.test','Other','fixture');
          UPDATE mailboxes SET user_id = 'other'`)
      }
      return batch(statements)
    }
    await assert.rejects(concurrent.run(), /malformed JSON/)
    assert.equal(concurrent.db.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count, 0)
    assert.equal(concurrent.db.prepare("SELECT storage_used_bytes FROM users WHERE email = ?").get(credentials.email)?.storage_used_bytes, 0)
  })

  it('uses OAuth only at the fixed Cloudflare origin and checks D1 batch/API failures', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = cloudflareClient(target, 'fixture-oauth', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Response.json({ success: true, result: [{ success: true, results: [{ count: 0 }] }] })
    })
    assert.deepEqual(await client.query('SELECT COUNT(*) AS count FROM users'), [{ count: 0 }])
    assert.ok(calls[0].url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${target.account}/`))
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer fixture-oauth')
    assert.equal(calls[0].init.redirect, 'error')
    await assert.rejects(client.batch([{ sql: 'SELECT 1', params: [] }, { sql: 'SELECT 2', params: [] }]), /batch result count mismatch/)
    const failed = cloudflareClient(target, 'fixture-oauth', async () => Response.json({ success: false, errors: [{ message: 'private response body' }] }))
    await assert.rejects(failed.query('SELECT 1'), /Cloudflare D1 query failed/)
  })
})
