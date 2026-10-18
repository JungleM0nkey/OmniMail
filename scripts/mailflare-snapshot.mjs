import { createHash } from 'node:crypto'
import PostalMime, { addressParser } from 'postal-mime'

export const SOURCE_DATABASE = '9e15235d-7c72-435e-8a76-09cc9c233c7d'
export const SOURCE_BUCKET = 'mailflare-raw'
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const check = (condition, message) => { if (!condition) throw new Error(message) }
export const messageId = (database, id) => `mfl_${sha256(`${database}:${id}`).slice(0, 32)}`
export const attachmentId = (database, id) => `mfl_a_${sha256(`${database}:${id}`).slice(0, 32)}`
export const objectKey = (database, key) => `mailflare/${database}/objects/${sha256(key)}`
export const metadataKey = (database, id) => `mailflare_import:${database}:${id}`

function unique(rows, name) {
  check(Array.isArray(rows), `Missing source ${name}`)
  const result = new Map()
  for (const row of rows) {
    check(row && typeof row.id === 'string' && row.id && !result.has(row.id), `Invalid or duplicate source ${name} ID`)
    result.set(row.id, row)
  }
  return result
}

function timestamp(value) {
  check(Number.isSafeInteger(value) && value >= 0 && value < 1e11, 'Invalid source timestamp (expected seconds)')
  return value
}

function addresses(value) {
  check(value == null || typeof value === 'string', 'Invalid source address header')
  const flatten = (rows) => rows.flatMap((row) => row.group ? flatten(row.group) : [row])
  const rows = flatten(addressParser(value || ''))
  check(!value || rows.length > 0, 'Unparseable source address header')
  for (const row of rows) check(typeof row.address === 'string' && /^[^\s@]+@[^\s@]+$/.test(row.address), 'Invalid source email address')
  return rows.map((row) => ({ address: row.address.toLowerCase(), name: row.name || null }))
}

function headerId(value) {
  if (!value) return null
  check(typeof value === 'string', 'Invalid source Message-ID')
  const clean = value.trim().replace(/^<|>$/g, '')
  check(clean && !/[<>\s]/.test(clean), 'Invalid source Message-ID')
  return `<${clean}>`
}

function references(value) {
  check(value == null || typeof value === 'string', 'Invalid source References header')
  return (value || '').split(/[\s,]+/).filter(Boolean).map(headerId)
}

export async function planSnapshot(snapshot, credentials, target, snapshotHash = sha256(JSON.stringify(snapshot))) {
  check(/^[a-f0-9]{32}$/.test(target.account), 'Invalid destination account')
  check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target.database), 'Invalid destination database ID')
  check(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(target.bucket), 'Invalid destination bucket')
  check(snapshot?.database === SOURCE_DATABASE && snapshot.bucket === SOURCE_BUCKET, 'Unexpected Mailflare source identity')
  check(snapshot.account === target.account, 'Source and destination accounts differ')
  check(target.database !== SOURCE_DATABASE && target.bucket !== SOURCE_BUCKET, 'Refusing to write into Mailflare resources')
  check(Number.isFinite(Date.parse(snapshot.createdAt)), 'Invalid snapshot creation time')
  const email = credentials?.email?.trim().toLowerCase()
  check(typeof email === 'string' && /^[^\s@]+@[^\s@]+$/.test(email), 'Invalid credential email')
  check(typeof credentials.password === 'string', 'Missing credential password')
  const messages = unique(snapshot.tables?.messages, 'messages')
  const attachments = unique(snapshot.tables?.message_attachments, 'attachments')
  const mailboxes = unique(snapshot.tables?.mailboxes, 'mailboxes')
  const domains = unique(snapshot.tables?.domains, 'domains')
  const mailboxRows = [...mailboxes.values()].map((source) => {
    const domain = domains.get(source.domain_id)
    check(domain && typeof domain.hostname === 'string' && typeof source.local_part === 'string', 'Missing source mailbox domain')
    const address = `${source.local_part}@${domain.hostname}`.toLowerCase()
    check(/^[^\s@]+@[^\s@]+$/.test(address), 'Invalid source mailbox address')
    check(!source.disabled, 'Disabled source mailbox needs an explicit migration decision')
    return { source, domain, address, created_at: timestamp(source.created_at) }
  })
  check(new Set(mailboxRows.map((row) => row.address)).size === mailboxRows.length, 'Duplicate source mailbox address')
  const primary = mailboxRows.find((row) => row.address === email)
  check(primary, 'Credential email has no source mailbox')
  check(mailboxRows.every((row) => row.source.user_id === primary.source.user_id), 'Snapshot contains another mailbox owner')
  const sourceObjects = new Map()
  check(Array.isArray(snapshot.objects), 'Missing source objects')
  for (const object of snapshot.objects) {
    check(typeof object.key === 'string' && object.key && !sourceObjects.has(object.key), 'Duplicate or invalid source object key')
    check(typeof object.base64 === 'string' && /^[a-f0-9]{64}$/.test(object.sha256), 'Invalid source object encoding')
    const bytes = Buffer.from(object.base64, 'base64')
    check(bytes.toString('base64') === object.base64 && bytes.length === object.size && sha256(bytes) === object.sha256, 'Source object integrity mismatch')
    sourceObjects.set(object.key, { key: objectKey(snapshot.database, object.key), bytes, size: bytes.length, sha256: object.sha256, contentType: 'application/octet-stream' })
  }
  const groupedAttachments = new Map()
  for (const attachment of attachments.values()) {
    check(messages.has(attachment.message_id), 'Orphan source attachment')
    const object = sourceObjects.get(attachment.r2_key)
    check(object && object.size === attachment.size, 'Source attachment object or size mismatch')
    check(typeof attachment.filename === 'string' && typeof attachment.content_type === 'string', 'Invalid source attachment metadata')
    const list = groupedAttachments.get(attachment.message_id) || []
    list.push(attachment)
    groupedAttachments.set(attachment.message_id, list)
  }
  const result = []
  const objects = new Map()
  const usedSourceKeys = new Set()
  for (const source of messages.values()) {
    const mailbox = mailboxRows.find((row) => row.source.id === source.mailbox_id)
    check(mailbox && source.user_id === primary.source.user_id, 'Source message has no owned mailbox')
    check(source.direction === 'inbound' || source.direction === 'outbound', 'Unsupported source direction')
    check(['received', 'sent', 'failed', 'trash'].includes(source.status), 'Unsupported source status; resolve before import')
    check(source.direction === 'inbound' ? source.status !== 'sent' : source.status !== 'received', 'Source direction/status conflict')
    check(!source.folder_id && !source.snoozed_until, 'Custom folders or snoozed mail need an explicit migration decision')
    check([0, 1].includes(source.read) && [0, 1].includes(source.starred), 'Invalid source read/starred flags')
    check((source.text_body == null || typeof source.text_body === 'string') && (source.html_body == null || typeof source.html_body === 'string'), 'Invalid source message body')
    check((source.subject == null || typeof source.subject === 'string') && (source.snippet == null || typeof source.snippet === 'string'), 'Invalid source subject or preview')
    check(source.thread_id == null || typeof source.thread_id === 'string', 'Invalid source thread ID')
    const createdAt = timestamp(source.created_at)
    const id = messageId(snapshot.database, source.id)
    const bytes = Buffer.from(JSON.stringify({ text: source.text_body ?? '', html: source.html_body ?? '' }))
    const body = { key: `mailflare/${snapshot.database}/bodies/${id}.json`, bytes, size: bytes.length, sha256: sha256(bytes), contentType: 'application/json; charset=utf-8' }
    const raw = source.raw_r2_key ? sourceObjects.get(source.raw_r2_key) : null
    check(!source.raw_r2_key || raw, 'Source raw MIME object is missing')
    if (raw) raw.contentType = 'message/rfc822'
    const parsed = raw ? await PostalMime.parse(raw.bytes) : null
    const sourceAttachments = (groupedAttachments.get(source.id) || []).sort((a, b) => a.id.localeCompare(b.id))
    for (const key of [...(raw ? [source.raw_r2_key] : []), ...sourceAttachments.map((attachment) => attachment.r2_key)]) {
      check(!usedSourceKeys.has(key), 'Shared source object needs independent target ownership before import')
      usedSourceKeys.add(key)
    }
    const attachmentRows = sourceAttachments.map((attachment) => ({
      id: attachmentId(snapshot.database, attachment.id), message_id: id,
      filename: attachment.filename, content_type: attachment.content_type, size: attachment.size,
      r2_key: sourceObjects.get(attachment.r2_key).key, content_id: attachment.content_id ?? null,
      disposition: attachment.disposition || 'attachment',
    }))
    const messageObjects = [body, ...(raw ? [raw] : []), ...sourceAttachments.map((attachment) => sourceObjects.get(attachment.r2_key))]
    for (const object of messageObjects) objects.set(object.key, object)
    const attachmentBytes = attachmentRows.reduce((total, attachment) => total + attachment.size, 0)
    const outgoing = source.direction === 'outbound'
    const quota = outgoing ? bytes.length + attachmentBytes : raw?.size ?? bytes.length + attachmentBytes
    const sender = addresses(source.from_addr)
    check(sender.length === 1, 'Source message must have one sender')
    const recipients = addresses(source.to_addr).map((row) => row.address)
    const cc = addresses(source.cc_addr).map((row) => row.address)
    const replyTo = addresses(source.reply_to).map((row) => row.address)
    const date = parsed?.date ? Math.floor(Date.parse(parsed.date) / 1000) : createdAt
    const row = {
      id, mailbox_address: mailbox.address, direction: outgoing ? 'outgoing' : 'incoming',
      status: source.status === 'failed' ? 'failed' : outgoing ? 'sent' : 'ready',
      folder: source.status === 'trash' || source.trashed_at ? 'trash' : outgoing ? 'sent' : 'inbox',
      message_id: headerId(source.provider_message_id || parsed?.messageId),
      in_reply_to: headerId(source.in_reply_to), references_header: references(source.references_header).join(' ') || null,
      sender_name: sender[0].name, sender_address: sender[0].address, delivered_to: null,
      recipients_json: JSON.stringify(recipients), cc_json: JSON.stringify(cc), reply_to_json: JSON.stringify(replyTo),
      subject: source.subject ?? '', preview: source.snippet ?? '',
      received_at: outgoing ? null : Number.isFinite(date) ? date : createdAt, sent_at: outgoing ? createdAt : null,
      raw_key: raw?.key ?? null, body_key: body.key, size: outgoing ? quota : raw?.size ?? quota,
      quota_bytes: quota, stored_bytes: (raw?.size ?? 0) + bytes.length + attachmentBytes,
      attachment_count: attachmentRows.length, has_html: source.html_body ? 1 : 0,
      is_read: source.read, is_starred: source.starred,
      trashed_at: source.trashed_at == null ? null : timestamp(source.trashed_at), purge_after: null,
      processing_error: null, delivery_status: outgoing ? source.status === 'failed' ? 'failed' : 'sent' : null,
      provider_id: outgoing ? source.provider_message_id ?? null : null, created_at: createdAt, updated_at: createdAt,
    }
    const content = [row.subject, row.sender_address, [...recipients, ...cc].join(' '), source.text_body || '']
      .join(' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200_000)
    result.push({ source, mailbox, row, attachmentRows, sourceAttachments, messageObjects, content })
  }
  check([...sourceObjects.values()].every((object) => objects.has(object.key)), 'Unreferenced source objects need an explicit migration decision')
  const ordered = [...result].sort((a, b) => Number(a.row.direction === 'outgoing') - Number(b.row.direction === 'outgoing') || a.source.id.localeCompare(b.source.id))
  const used = new Set()
  for (const message of ordered) {
    const row = message.row
    const refs = references(row.references_header)
    const key = `${row.mailbox_address}:${row.message_id}`
    if (row.message_id && used.has(key)) {
      refs.push(row.message_id)
      row.message_id = `<mfl-${row.id}@mailflare.invalid>`
    }
    if (row.message_id) used.add(key)
    if (message.source.thread_id && result.some((other) => other !== message && other.mailbox.address === message.mailbox.address && other.source.thread_id === message.source.thread_id)) {
      refs.push(`<mfl-thread-${sha256(`${snapshot.database}:${message.source.thread_id}`).slice(0, 32)}@mailflare.invalid>`)
    }
    row.references_header = [...new Set(refs)].join(' ') || null
    const { text_body, html_body, ...sourceMetadata } = message.source
    message.metadata = {
      version: 1, source: sourceMetadata, attachments: message.sourceAttachments,
      mailbox: message.mailbox.source, domain: message.mailbox.domain,
      row, attachmentRows: message.attachmentRows,
      objects: message.messageObjects.map(({ key: objectKey, size, sha256: hash }) => ({ key: objectKey, size, sha256: hash })),
      bodyNulls: { text: text_body == null, html: html_body == null }, snapshotCreatedAt: snapshot.createdAt,
    }
    message.metadataKey = metadataKey(snapshot.database, message.source.id)
  }
  return {
    snapshot, snapshotHash, email, primary, mailboxes: mailboxRows, messages: result, objects: [...objects.values()],
    objectManifestSha256: sha256(JSON.stringify(snapshot.objects.map(({ key, size, sha256: hash }) => ({ key, size, sha256: hash })).sort((a, b) => a.key.localeCompare(b.key)))),
  }
}
