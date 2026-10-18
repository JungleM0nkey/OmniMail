import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { listMessageThread } from '../src/features/messages/message-thread'
import type { MessageRow, SessionUser } from '../src/app/types'

const owner = { id: 'thread-owner' } as SessionUser
const address = 'thread@example.com'
const nativeId = '<native@example.com>'

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  for (const id of [owner.id, 'thread-other']) {
    await env.DB.prepare('INSERT INTO users (id,email,display_name,password_hash) VALUES (?,?,?,?)')
      .bind(id, `${id}@example.com`, id, 'test').run()
  }
  for (const [mailbox, userId] of [[address, owner.id], ['other@example.com', 'thread-other']]) {
    await env.DB.prepare('INSERT INTO mailboxes (address,user_id) VALUES (?,?)').bind(mailbox, userId).run()
  }
  const ancestry = Array.from({ length: 25 }, (_, i) => `<ancestor${i}@example.com>`).join(' ')
  for (const [id, mailbox, direction, messageId, replyTo, references, providerId] of [
    ['sent-native', address, 'outgoing', null, null, ancestry, `cloudflare:${nativeId}`],
    ['self-copy', address, 'incoming', nativeId, null, null, null],
    ['reply-native', address, 'incoming', '<reply@example.com>', nativeId, null, null],
    ['foreign', 'other@example.com', 'outgoing', null, null, null, `cloudflare:${nativeId}`],
  ]) {
    await env.DB.prepare(`INSERT INTO messages
      (id,mailbox_address,direction,status,folder,sender_address,message_id,in_reply_to,references_header,provider_id)
      VALUES (?,?,?,?,?,'sender@example.net',?,?,?,?)`)
      .bind(id, mailbox, direction, direction === 'outgoing' ? 'sent' : 'ready',
        direction === 'outgoing' ? 'sent' : 'inbox', messageId, replyTo, references, providerId).run()
  }
})

describe('native Cloudflare message threading', () => {
  it.each(['sent-native', 'self-copy', 'reply-native'])('finds both directions from %s without changing Message-ID', async (id) => {
    const selected = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<MessageRow>()
    const thread = await listMessageThread(env, owner, selected!)
    expect(thread.map((message) => message.id).sort()).toEqual(['reply-native', 'self-copy', 'sent-native'])
  })
})
