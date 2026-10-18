import { describe, expect, it } from 'vitest'
import { apiReader, cliOptions, cloudflareReader, verifyImport } from './verify-mailflare-import.mjs'
import {
  archiveKey, expectedAttachment, expectedMessages, expectedSummary, objectKey,
  searchContent, sha256, validateSnapshot, verifyFramePolicy,
} from './verify-mailflare-snapshot.mjs'

const account = 'a'.repeat(32)
const database = '11111111-1111-1111-1111-111111111111'
const targetDatabase = '22222222-2222-2222-2222-222222222222'
const base = 'https://mail.example.com'
const credentials = { email: 'owner@example.com', password: 'fixture-private-password' }
const privateBody = 'Private content ZebraSearchToken'
const frameHeaders = { 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self' https://console.apehost.dev;" }
const object = (key: string, bytes: Buffer) => ({ key, size: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') })

function snapshotFixture() {
  const source = {
    id: 'sent', user_id: 'legacy-owner', mailbox_id: 'box', direction: 'outbound',
    provider_message_id: 'same@example.com', from_addr: 'Owner <owner@example.com>', to_addr: 'owner@example.com',
    subject: 'Fixture subject', snippet: 'Fixture preview', status: 'sent', thread_id: 'same-thread',
    created_at: 1792249205, read: 1, folder_id: null, snoozed_until: null, starred: 0,
    text_body: privateBody, html_body: null, raw_r2_key: null, cc_addr: null, bcc_addr: null,
    in_reply_to: null, references_header: null, spam_score: null, spam_verdict: null,
    spam_signals: null, spam_analyzed_at: null, spam_analysis_error: null, trashed_at: null, reply_to: null,
  }
  return {
    createdAt: '2026-10-18T00:00:00.000Z', account, database, bucket: 'legacy-bucket',
    tables: {
      messages: [source, { ...source, id: 'received', direction: 'inbound', status: 'received',
        created_at: 1792249210, raw_r2_key: 'raw/received.eml', read: 0, starred: 1,
        spam_score: 3, spam_signals: '{"legacy":"retained"}' }],
      message_attachments: [{ id: 'attachment', message_id: 'sent', filename: 'data.bin', content_type: 'application/octet-stream',
        size: 4, disposition: 'attachment', content_id: null, r2_key: 'attachment/data', created_at: 1792249205, trashed_at: null }],
      mailboxes: [{ id: 'box', user_id: 'legacy-owner', domain_id: 'domain', local_part: 'owner', display_name: 'Owner', disabled: 0 }],
      domains: [{ id: 'domain', user_id: 'legacy-owner', hostname: 'example.com', sending_enabled: 1 }],
    },
    objects: [object('raw/received.eml', Buffer.from('Date: Sat, 17 Oct 2026 15:00:00 +0000\r\nMessage-ID: <same@example.com>\r\nFrom: owner@example.com\r\nTo: owner@example.com\r\n\r\nRaw body\r\n')),
      object('attachment/data', Buffer.from([0, 1, 2, 255]))],
  }
}

async function targetFixture() {
  const snapshot = snapshotFixture()
  const expected = await expectedMessages(snapshot)
  const messages = expected.map((item) => ({ ...item.row, _mailbox_hidden: 0 }))
  const attachments = snapshot.tables.message_attachments.map((source) => expectedAttachment(snapshot, source))
  const objects = new Map(snapshot.objects.map((source) => [objectKey(database, source.key), Buffer.from(source.base64, 'base64')]))
  const archives = expected.map((item) => {
    objects.set(item.row.body_key, Buffer.from(JSON.stringify(item.body)))
    const { text_body: _text, html_body: _html, ...source } = item.source
    return { key: archiveKey(database, source.id), value: JSON.stringify({ version: 1, source,
      attachments: item.attachments, mailbox: item.mailbox, domain: item.domain, row: item.row,
      objects: item.objects, bodyNulls: { text: false, html: true }, snapshotCreatedAt: snapshot.createdAt }) }
  })
  const actor = { id: 'new-owner', email: credentials.email }
  const users = [{ ...actor, status: 'active', deleted_at: null,
    storage_quota_bytes: 1000000, storage_used_bytes: messages.reduce((sum, row) => sum + row.quota_bytes, 0) }]
  const mailboxes = [{ address: credentials.email, user_id: actor.id, is_active: 1, is_primary: 1, is_hidden: 0, domain_active: 1 }]
  const search = expected.map((item) => ({ message_id: item.row.id, content: searchContent(item.row, item.body) }))
  let loggedIn = false
  const requests: Array<{ path: string; options: Record<string, any> }> = []
  const cf = {
    settings: async () => ({ bindings: [{ name: 'DB', id: targetDatabase }, { name: 'MAIL_BUCKET', bucket_name: 'target-bucket' }, { name: 'EMAIL', type: 'send_email' }] }),
    deployments: async () => ({ deployments: [{ id: 'deployment-1', created_on: '2026-10-18T01:00:00Z', versions: [{ version_id: 'version-1', percentage: 100 }] }] }),
    query: async (sql: string) => {
      if (sql.includes('FROM users')) return structuredClone(users)
      if (sql.includes('FROM mailboxes')) return structuredClone(mailboxes)
      if (sql.includes('FROM messages m')) return structuredClone(messages)
      if (sql.includes('FROM attachments')) return structuredClone(attachments)
      if (sql.includes('FROM message_search')) return structuredClone(search)
      if (sql.includes('FROM settings')) return structuredClone(archives)
      if (sql.includes('FROM mail_draft_attachments')) return [{ bytes: 0 }]
      if (sql.includes('FROM mail_drafts')) return [{ count: 0 }]
      throw new Error('fixture.unexpected-query')
    },
    object: async (key: string) => { if (!objects.has(key)) throw new Error('fixture.object.missing'); return objects.get(key) },
  }
  const api = async (path: string, options: Record<string, any> = {}) => {
    requests.push({ path, options })
    if (path === '/') return new Response('Fixture', { headers: frameHeaders })
    if (path === '/api/login') {
      if (options.json.email !== credentials.email || options.json.password !== credentials.password) return Response.json({}, { status: 401 })
      loggedIn = true
      return Response.json({ user: actor })
    }
    if (path === '/api/session') return Response.json({ user: loggedIn ? actor : null })
    if (path === '/api/logout') {
      if (options.origin !== base) return Response.json({}, { status: 403 })
      loggedIn = false
      return Response.json({ ok: true })
    }
    if (!loggedIn || options.anonymous) return Response.json({}, { status: 401 })
    if (path === '/api/mailboxes') return Response.json({ mailboxes: [{ address: credentials.email, isActive: true, domainActive: true }] })
    const url = new URL(path, base)
    if (url.pathname === '/api/messages') {
      const folder = url.searchParams.get('folder')
      const q = url.searchParams.get('q')
      const matching = messages.filter((row) => folder === 'starred' ? row.is_starred && row.folder !== 'trash' : row.folder === folder)
        .filter((row) => !q || search.find((entry) => entry.message_id === row.id)?.content.includes(q))
      const offset = Number(url.searchParams.get('cursor') || 0)
      const page = matching.slice(offset, offset + 1)
      return Response.json({ messages: page.map(expectedSummary), counts: { unread: 1, starred: 1, sent: 1, trash: 0, drafts: 0 },
        page: { hasMore: offset + 1 < matching.length, nextCursor: offset + 1 < matching.length ? String(offset + 1) : null } })
    }
    const parts = url.pathname.split('/')
    const item = expected.find((entry) => entry.row.id === parts[3])
    if (!item) return Response.json({}, { status: 404 })
    if (parts[4] === 'attachments') {
      const attachment = attachments.find((entry) => entry.id === parts[5])!
      return new Response(objects.get(attachment.r2_key), { headers: { 'Content-Type': attachment.content_type } })
    }
    if (parts[4] === 'raw') return new Response(objects.get(item.row.raw_key))
    return Response.json({ message: { ...expectedSummary(item.row), messageId: item.row.message_id, inReplyTo: item.row.in_reply_to,
      references: item.row.references_header, replyTo: item.row.sender_address, cc: [], ...item.body,
      attachments: attachments.filter((row) => row.message_id === item.row.id).map((row) => ({ id: row.id,
        filename: row.filename, contentType: row.content_type, size: row.size, contentId: row.content_id, disposition: row.disposition })) },
      thread: messages.map(expectedSummary) })
  }
  return { snapshot, expected, objects, archives, messages, api, cf, requests,
    options: { snapshot, snapshotBytes: Buffer.from(JSON.stringify(snapshot)), account, database: targetDatabase,
      bucket: 'target-bucket', base, credentials, revision: 'fixture-revision' } }
}

describe('independent Mailflare verification', () => {
  it('retains both self-send copies, original timestamps, and a shared thread marker', async () => {
    const fixture = await targetFixture()
    const sent = fixture.expected.find((item) => item.source.id === 'sent')!
    const received = fixture.expected.find((item) => item.source.id === 'received')!
    expect(received.row.message_id).toBe('<same@example.com>')
    expect(sent.row.message_id).toMatch(/^<mfl-mfl_[a-f0-9]{32}@mailflare\.invalid>$/)
    expect(sent.row.references_header).toContain('<same@example.com>')
    expect(received.row.references_header).toMatch(/^<mfl-thread-[a-f0-9]{32}@mailflare\.invalid>$/)
    expect(sent.row.references_header).toContain(received.row.references_header)
    expect(received.row.created_at).toBe(1792249210)
    expect(received.row.received_at).toBe(Date.parse('2026-10-17T15:00:00Z') / 1000)
    expect(received.body.html).toBe('')
  })

  it.each(['bytes', 'hash', 'missing-object', 'duplicate-id', 'orphan'])('refuses a snapshot with %s corruption', (kind) => {
    const snapshot = snapshotFixture()
    if (kind === 'bytes') snapshot.objects[0].base64 = Buffer.from('different').toString('base64')
    if (kind === 'hash') snapshot.objects[0].sha256 = '0'.repeat(64)
    if (kind === 'missing-object') snapshot.objects.shift()
    if (kind === 'duplicate-id') snapshot.tables.messages.push({ ...snapshot.tables.messages[0] })
    if (kind === 'orphan') snapshot.tables.message_attachments[0].message_id = 'absent'
    expect(() => validateSnapshot(snapshot)).toThrow(/^snapshot\./)
  })

  it('passes independently read data and records browser/delivery gaps without secrets', async () => {
    const fixture = await targetFixture()
    const receipt = await verifyImport(fixture.options, fixture)
    expect(receipt.status).toBe('PASSED')
    expect(receipt.parity.verified).toBe(true)
    expect(receipt.parity.counts).toMatchObject({ sourceMessages: 2, sourceAttachments: 1, sourceObjects: 2, verifiedObjects: 2, verifiedBodies: 2 })
    expect(receipt.remainingAcceptance.every((item) => item.status === 'UNVERIFIED')).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain(privateBody)
    expect(JSON.stringify(receipt)).not.toContain(credentials.password)
    expect(fixture.requests.filter(({ options }) => options.method && options.method !== 'GET').map(({ path }) => path))
      .toEqual(['/api/login', '/api/logout', '/api/logout', '/api/logout'])
  })

  it.each(['body', 'attachment-bytes', 'archived-metadata', 'missing-message', 'api-body', 'api-counts'])(
    'fails real parity after %s tampering even when other data agrees', async (kind) => {
      const fixture = await targetFixture()
      const sent = fixture.expected.find((item) => item.source.id === 'sent')!
      if (kind === 'body') fixture.objects.set(sent.row.body_key, Buffer.from(JSON.stringify({ text: 'Wrong', html: '' })))
      if (kind === 'attachment-bytes') fixture.objects.set(objectKey(database, 'attachment/data'), Buffer.from([0, 1, 2, 0]))
      if (kind === 'archived-metadata') {
        const metadata = JSON.parse(fixture.archives[0].value)
        metadata.source.spam_score = 999
        fixture.archives[0].value = JSON.stringify(metadata)
      }
      if (kind === 'missing-message') fixture.messages.splice(0, 1)
      const originalApi = fixture.api
      if (kind.startsWith('api-')) fixture.api = async (path, options) => {
        const response = await originalApi(path, options)
        if (!options?.anonymous && path.startsWith('/api/messages') && response.status === 200) {
          const value = await response.clone().json().catch(() => null)
          if (kind === 'api-body' && value?.message) { value.message.text = 'Wrong'; return Response.json(value) }
          if (kind === 'api-counts' && value?.counts) { value.counts.sent = 900; return Response.json(value) }
        }
        return response
      }
      const receipt = await verifyImport(fixture.options, fixture)
      expect(receipt.status).toBe('FAILED')
      expect(receipt.parity.verified).toBe(false)
      expect(receipt.parity.checks.some((item) => item.required && item.status === 'FAILED')).toBe(true)
      expect(JSON.stringify(receipt)).not.toContain(privateBody)
      expect(JSON.stringify(receipt)).not.toContain(credentials.password)
    },
  )

  it('checks exact framing parents and refuses conflicting X-Frame-Options', () => {
    expect(() => verifyFramePolicy(new Headers(frameHeaders))).not.toThrow()
    for (const value of ["frame-ancestors *", "frame-ancestors 'self' https://untrusted.example", "frame-ancestors 'self'; frame-ancestors https://console.apehost.dev"]) {
      expect(() => verifyFramePolicy(new Headers({ 'Content-Security-Policy': value }))).toThrow(/^framing\./)
    }
    expect(() => verifyFramePolicy(new Headers({ ...frameHeaders, 'X-Frame-Options': 'SAMEORIGIN' }))).toThrow(/^framing\./)
  })

  it('confines OAuth to Cloudflare and refuses non-SELECT statements', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const reader = cloudflareReader(account, targetDatabase, 'target-bucket', 'private-oauth', async (url, init) => {
      calls.push({ url, init })
      return Response.json({ success: true, result: [{ success: true, results: [] }] })
    })
    await expect(reader.query('DELETE FROM messages')).rejects.toThrow('cloudflare.query.must-be-read-only')
    await reader.query('SELECT id FROM messages WHERE id = ?', ['opaque-id'])
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0].url).origin).toBe('https://api.cloudflare.com')
    expect(calls[0].init.redirect).toBe('error')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ sql: 'SELECT id FROM messages WHERE id = ?', params: ['opaque-id'] })
  })

  it('keeps the owner cookie only in signed-in requests and refuses redirects', async () => {
    const calls: RequestInit[] = []
    const api = apiReader(base, async (_url, init) => {
      calls.push(init)
      return Response.json({}, { headers: { 'Set-Cookie': 'omnimail_session=private-session; Path=/; Secure; HttpOnly; SameSite=Lax' } })
    })
    await api('/api/login', { method: 'POST', json: credentials })
    await api('/api/messages')
    await api('/api/messages', { anonymous: true })
    expect(calls.every((call) => call.redirect === 'error')).toBe(true)
    expect(calls[1].headers.Cookie).toBe('omnimail_session=private-session')
    expect(calls[2].headers.Cookie).toBeUndefined()
  })

  it('requires an explicit HTTPS origin and never accepts an outbound execution flag', () => {
    const args = ['--base', base, '--snapshot', 'private.json', '--account', account, '--database', targetDatabase, '--bucket', 'target-bucket', '--receipt', 'receipt.json']
    expect(cliOptions(args).base).toBe(base)
    expect(() => cliOptions([...args, '--execute'])).toThrow()
    expect(() => cliOptions(args.map((arg) => arg === base ? 'https://user:secret@mail.example.com/path' : arg))).toThrow('arguments.base.must-be-https-origin')
  })
})
