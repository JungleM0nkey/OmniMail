import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import PostalMime, { addressParser } from 'postal-mime'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
export function stableJson(value) {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)
}
export function stateFingerprint(name, rows, key) {
  return { name, rows: rows.length, sha256: sha256(stableJson([...rows]
    .sort((a, b) => String(a[key]).localeCompare(String(b[key]), 'en')))) }
}
export function ensure(condition, code) {
  if (!condition) throw new Error(code)
}
export function equal(actual, expected, code) {
  ensure(isDeepStrictEqual(actual, expected), code)
}
export const messageId = (database, id) => `mfl_${sha256(`${database}:${id}`).slice(0, 32)}`
export const attachmentId = (database, id) => `mfl_a_${sha256(`${database}:${id}`).slice(0, 32)}`
export const objectKey = (database, key) => `mailflare/${database}/objects/${sha256(key)}`
export const bodyKey = (database, id) => `mailflare/${database}/bodies/${messageId(database, id)}.json`
export const archiveKey = (database, id) => `mailflare_import:${database}:${id}`
export const normalizedMessageId = (value) => value?.trim() ? `<${value.trim().replace(/^<|>$/g, '')}>` : null

export function addresses(value) {
  if (!value) return []
  let input = value
  if (typeof input === 'string' && input.trim().startsWith('[')) {
    try { input = JSON.parse(input) } catch { throw new Error('snapshot.addresses.invalid-json') }
  }
  if (Array.isArray(input)) return input.flatMap(addresses)
  ensure(typeof input === 'string', 'snapshot.addresses.invalid-type')
  const flatten = (items) => items.flatMap((item) => item.group ? flatten(item.group) : [item])
  const parsed = flatten(addressParser(input))
  ensure(parsed.length > 0 && parsed.every((item) => /^[^\s<>@]+@[^\s<>@]+$/.test(item.address || '')),
    'snapshot.addresses.invalid')
  return parsed.map((item) => ({ address: item.address.toLowerCase(), name: item.name || '' }))
}

export function validateSnapshot(snapshot) {
  ensure(snapshot && /^[a-f0-9]{32}$/i.test(snapshot.account || ''), 'snapshot.account.invalid')
  ensure(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(snapshot.database || ''), 'snapshot.database.invalid')
  ensure(typeof snapshot.bucket === 'string' && snapshot.bucket.length > 0, 'snapshot.bucket.missing')
  ensure(Number.isFinite(Date.parse(snapshot.createdAt)), 'snapshot.createdAt.invalid')
  for (const table of ['messages', 'message_attachments', 'mailboxes', 'domains']) {
    ensure(Array.isArray(snapshot.tables?.[table]), `snapshot.${table}.missing`)
    const rows = snapshot.tables[table]
    ensure(rows.every((row) => typeof row.id === 'string' && row.id.length > 0), `snapshot.${table}.invalid-id`)
    ensure(new Set(rows.map((row) => row.id)).size === rows.length, `snapshot.${table}.duplicate-id`)
  }
  ensure(Array.isArray(snapshot.objects), 'snapshot.objects.missing')
  const objects = new Map()
  for (const object of snapshot.objects) {
    ensure(typeof object.key === 'string' && object.key && !objects.has(object.key), 'snapshot.objects.duplicate-or-invalid-key')
    ensure(typeof object.base64 === 'string', 'snapshot.object.bytes.missing')
    const bytes = Buffer.from(object.base64, 'base64')
    equal(bytes.toString('base64'), object.base64, 'snapshot.object.base64.invalid')
    equal(bytes.length, object.size, 'snapshot.object.size.mismatch')
    equal(sha256(bytes), object.sha256, 'snapshot.object.hash.mismatch')
    objects.set(object.key, { ...object, bytes })
  }
  const messages = new Map(snapshot.tables.messages.map((row) => [row.id, row]))
  const mailboxes = new Map(snapshot.tables.mailboxes.map((row) => [row.id, row]))
  const domains = new Map(snapshot.tables.domains.map((row) => [row.id, row]))
  for (const message of messages.values()) {
    const mailbox = mailboxes.get(message.mailbox_id)
    ensure(mailbox && domains.has(mailbox.domain_id), 'snapshot.message.mailbox-or-domain.missing')
    equal(message.user_id, mailbox.user_id, 'snapshot.message.owner.mismatch')
    ensure(['inbound', 'outbound'].includes(message.direction), 'snapshot.message.direction.unsupported')
    ensure(['received', 'sent', 'failed', 'trash'].includes(message.status), 'snapshot.message.status.unsupported')
    ensure(!message.folder_id && !message.snoozed_until, 'snapshot.message.custom-folder-or-snooze.unsupported')
    ensure(Number.isSafeInteger(message.created_at) && message.created_at >= 0, 'snapshot.message.timestamp.invalid')
    ensure([0, 1].includes(message.read) && [0, 1].includes(message.starred), 'snapshot.message.flags.invalid')
    for (const field of ['text_body', 'html_body']) {
      ensure(message[field] === null || typeof message[field] === 'string', 'snapshot.message.body.invalid')
    }
    if (message.raw_r2_key) ensure(objects.has(message.raw_r2_key), 'snapshot.message.raw.missing')
  }
  for (const attachment of snapshot.tables.message_attachments) {
    ensure(messages.has(attachment.message_id), 'snapshot.attachment.orphan')
    ensure(objects.has(attachment.r2_key), 'snapshot.attachment.object.missing')
    equal(attachment.size, objects.get(attachment.r2_key).size, 'snapshot.attachment.size.mismatch')
  }
  return { messages, mailboxes, domains, objects }
}

export function mailboxAddress(mailbox, domain) {
  ensure(typeof mailbox.local_part === 'string' && typeof domain.hostname === 'string', 'snapshot.mailbox.address.invalid')
  const values = addresses(`${mailbox.local_part}@${domain.hostname}`)
  equal(values.length, 1, 'snapshot.mailbox.address.invalid')
  return values[0].address
}

export async function expectedMessages(snapshot) {
  const objects = new Map(snapshot.objects.map((object) => [object.key, object]))
  const parsed = new Map(await Promise.all(snapshot.tables.messages.map(async (source) => [source.id,
    source.raw_r2_key ? await PostalMime.parse(Buffer.from(objects.get(source.raw_r2_key).base64, 'base64')) : null])))
  return snapshot.tables.messages.map((source) => expectedMessage(snapshot, source, parsed))
}

export function expectedMessage(snapshot, source, parsed = new Map()) {
  const mailbox = snapshot.tables.mailboxes.find((item) => item.id === source.mailbox_id)
  const domain = snapshot.tables.domains.find((item) => item.id === mailbox.domain_id)
  const sender = addresses(source.from_addr)
  equal(sender.length, 1, 'snapshot.sender.invalid')
  const incoming = source.direction === 'inbound'
  const recipients = addresses(source.to_addr).map((item) => item.address)
  const cc = addresses(source.cc_addr).map((item) => item.address)
  const replyTo = addresses(source.reply_to).map((item) => item.address)
  const id = messageId(snapshot.database, source.id)
  const effectiveId = (item) => normalizedMessageId(item.provider_message_id || parsed.get(item.id)?.messageId)
  const providerId = effectiveId(source)
  const duplicates = snapshot.tables.messages.filter((item) => item.direction === 'inbound' && item.mailbox_id === source.mailbox_id
    && effectiveId(item) === providerId && providerId)
    .sort((a, b) => Number(b.direction === 'inbound') - Number(a.direction === 'inbound') || a.id.localeCompare(b.id))
  const canonical = !providerId || duplicates[0]?.id === source.id
  const nativeId = incoming && canonical ? providerId : `<mfl-${id}@mailflare.invalid>`
  const references = (source.references_header || '').match(/<[^<>\s]+>|[^\s,]+/g)?.map(normalizedMessageId) || []
  if (nativeId !== providerId && providerId) references.push(providerId)
  if (source.thread_id) {
    references.push(`<mfl-thread-${sha256(`${snapshot.database}:${source.thread_id}`).slice(0, 32)}@mailflare.invalid>`)
  }
  const attachments = snapshot.tables.message_attachments.filter((item) => item.message_id === source.id)
  const body = { text: source.text_body ?? '', html: source.html_body ?? '' }
  const bodyBytes = Buffer.from(JSON.stringify(body))
  const sourceObjects = new Map(snapshot.objects.map((object) => [object.key, object]))
  const raw = sourceObjects.get(source.raw_r2_key)
  const attachmentBytes = attachments.reduce((sum, item) => sum + item.size, 0)
  const quota = incoming && raw ? raw.size : bodyBytes.length + attachmentBytes
  const parsedDate = Date.parse(parsed.get(source.id)?.date || '') / 1000
  const receivedAt = Number.isFinite(parsedDate) ? Math.floor(parsedDate) : source.created_at
  return {
    source, mailbox, domain, attachments, body,
    objects: [{ key: bodyKey(snapshot.database, source.id), size: bodyBytes.length, sha256: sha256(bodyBytes) },
      ...[...(raw ? [raw] : []), ...attachments.map((item) => sourceObjects.get(item.r2_key))]
        .map((object) => ({ key: objectKey(snapshot.database, object.key), size: object.size, sha256: object.sha256 }))],
    row: {
      id, mailbox_address: mailboxAddress(mailbox, domain),
      direction: incoming ? 'incoming' : 'outgoing',
      status: source.status === 'failed' ? 'failed' : incoming ? 'ready' : 'sent',
      folder: source.trashed_at != null || source.status === 'trash' ? 'trash' : incoming ? 'inbox' : 'sent',
      message_id: nativeId,
      in_reply_to: normalizedMessageId(source.in_reply_to),
      references_header: [...new Set(references)].join(' ') || null,
      sender_address: sender[0].address, sender_name: sender[0].name || null,
      delivered_to: null,
      recipients_json: JSON.stringify(recipients), cc_json: JSON.stringify(cc), reply_to_json: JSON.stringify(replyTo),
      subject: source.subject ?? '', preview: source.snippet ?? '',
      received_at: incoming ? receivedAt : null, sent_at: incoming ? null : source.created_at,
      created_at: source.created_at, updated_at: source.created_at, is_read: source.read, is_starred: source.starred,
      raw_key: source.raw_r2_key ? objectKey(snapshot.database, source.raw_r2_key) : null,
      body_key: bodyKey(snapshot.database, source.id), attachment_count: attachments.length,
      has_html: Number(Boolean(source.html_body)), trashed_at: source.trashed_at ?? null,
      purge_after: null, processing_error: null,
      delivery_status: incoming ? null : source.status === 'failed' ? 'failed' : 'sent',
      provider_id: incoming ? null : source.provider_message_id ?? null,
      size: incoming && raw ? raw.size : quota, quota_bytes: quota,
      stored_bytes: (raw?.size ?? 0) + bodyBytes.length + attachmentBytes,
    },
  }
}

export function expectedAttachment(snapshot, source) {
  return {
    id: attachmentId(snapshot.database, source.id), message_id: messageId(snapshot.database, source.message_id),
    filename: source.filename, content_type: source.content_type, size: source.size,
    r2_key: objectKey(snapshot.database, source.r2_key), content_id: source.content_id ?? null,
    disposition: source.disposition || 'attachment',
  }
}

export function expectedSummary(row) {
  return {
    id: row.id, mailboxAddress: row.delivered_to || row.mailbox_address,
    direction: row.direction, status: row.status, folder: row.folder,
    senderName: row.sender_name || '', senderAddress: row.sender_address,
    recipients: JSON.parse(row.recipients_json), subject: row.subject || '无主题', preview: row.preview,
    date: (row.received_at ?? row.sent_at ?? row.created_at) * 1000,
    attachmentCount: row.attachment_count, isRead: Boolean(row.is_read), isStarred: Boolean(row.is_starred),
    processingError: row.processing_error, deliveryStatus: row.delivery_status,
    purgeAfter: row.purge_after ? row.purge_after * 1000 : null,
  }
}

export function searchContent(row, body) {
  return [row.subject, row.sender_address, [...JSON.parse(row.recipients_json), ...JSON.parse(row.cc_json)].join(' '), body.text]
    .join(' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200_000)
}

export function verifyArchive(archive, expected) {
  const { text_body: _text, html_body: _html, ...metadata } = expected.source
  equal(archive.version, 1, 'archive.version.mismatch')
  equal(archive.source, metadata, 'archive.source.mismatch')
  equal([...archive.attachments].sort((a, b) => a.id.localeCompare(b.id)),
    [...expected.attachments].sort((a, b) => a.id.localeCompare(b.id)), 'archive.attachments.mismatch')
  equal(archive.mailbox, expected.mailbox, 'archive.mailbox.mismatch')
  equal(archive.domain, expected.domain, 'archive.domain.mismatch')
  equal(archive.bodyNulls, { text: expected.source.text_body === null, html: expected.source.html_body === null },
    'archive.body-null-markers.mismatch')
  equal([...archive.objects].sort((a, b) => a.key.localeCompare(b.key)),
    [...expected.objects].sort((a, b) => a.key.localeCompare(b.key)), 'archive.objects.mismatch')
  for (const [key, value] of Object.entries(expected.row)) equal(archive.row?.[key], value, `archive.row.${key}.mismatch`)
}

export function verifyFramePolicy(headers) {
  const policy = headers.get('content-security-policy') || ''
  const ancestors = policy.split(';').filter((part) => /^\s*frame-ancestors(?:\s|$)/i.test(part))
  equal(ancestors.length, 1, 'framing.ancestors.missing-or-duplicate')
  const allowed = ancestors[0].trim().split(/\s+/).slice(1).sort()
  equal(allowed, ["'self'", 'https://console.apehost.dev'].sort(), 'framing.ancestors.mismatch')
  ensure(!headers.has('x-frame-options'), 'framing.conflicting-x-frame-options')
}
