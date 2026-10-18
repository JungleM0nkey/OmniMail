import { describe, expect, it, vi } from 'vitest'
import { deliverOutboundMessage } from './outbound-message'
import { deliverWithCloudflare } from './outbound-cloudflare-provider'
import type { Env } from '../../app/types'

describe('native Cloudflare outbound delivery', () => {
  it.each(['E_CONTENT_TOO_LARGE', 'E_RATE_LIMIT_EXCEEDED', 'E_SENDER_NOT_VERIFIED'])(
    'allows a corrected retry after Cloudflare explicitly rejects %s', async (code) => {
      const send = vi.fn().mockRejectedValue(Object.assign(new Error('Rejected by Cloudflare'), { code }))
      await expect(deliverWithCloudflare({ send } as unknown as SendEmail, {
        replyTo: 'owner@example.com', to: ['friend@example.net'], subject: 'Test',
        text: 'Body', html: '', headers: {}, attachments: [],
      }, 'Owner')).rejects.toMatchObject({ retryable: false, deliveryUncertain: false })
      expect(send).toHaveBeenCalledOnce()
    },
  )

  it.each(['success', 'uncertain', 'missing-id', 'recording-failure'])('%s', async (outcome) => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const send = vi.fn(async () => {
      if (outcome === 'uncertain') throw new Error('connection lost')
      return { messageId: outcome === 'missing-id' ? '' : 'native-1' }
    })
    const env = {
      EMAIL: { send },
      DB: {
        prepare(sql: string) {
          return {
            bind(...bindings: unknown[]) { statements.push({ sql, bindings }); return this },
            first: async () => ({
              id: 'out-native', status: 'processing', mailbox_address: 'owner@example.com',
              sender_name: 'Owner', recipients_json: '["friend@example.net"]', subject: 'Native mail',
              body_key: 'bodies/native.json', in_reply_to: '<original@example.net>',
              references_header: '<original@example.net>', client_request_id: 'native-request',
              domain_is_active: 1,
            }),
            all: async () => ({ results: [{
              filename: 'data.bin', r2_key: 'attachments/data', content_type: 'application/octet-stream',
            }] }),
            run: async () => {
              if (outcome === 'recording-failure' && sql.includes("SET status = 'sent'")) {
                throw new Error('D1 unavailable')
              }
              return { meta: { changes: 1 } }
            },
          }
        },
      },
      MAIL_BUCKET: {
        get: async (key: string) => key === 'bodies/native.json'
          ? new Response(JSON.stringify({ text: 'Body', html: '<p>Body</p>' }))
          : new Response(new Uint8Array([0, 1, 255])),
      },
    } as unknown as Env
    const delivery = deliverOutboundMessage(env, {
      kind: 'outbound', messageId: 'out-native', userId: 'user-1', ip: '127.0.0.1',
      auditAction: 'message.send', auditDetail: {},
    })
    if (outcome === 'uncertain' || outcome === 'missing-id') {
      await expect(delivery).rejects.toMatchObject({ retryable: false, deliveryUncertain: true })
    } else if (outcome === 'recording-failure') {
      await expect(delivery).rejects.toMatchObject({
        name: 'OutboundProviderAcceptedError', providerId: 'cloudflare:native-1',
      })
    } else {
      await delivery
      expect(statements.some(({ sql, bindings }) => sql.includes("SET status = 'sent'")
        && bindings.includes('cloudflare:native-1'))).toBe(true)
      expect(send).toHaveBeenCalledWith({
        from: { name: 'Owner', email: 'owner@example.com' }, to: ['friend@example.net'],
        replyTo: 'owner@example.com', subject: 'Native mail', text: 'Body', html: '<p>Body</p>',
        headers: { 'In-Reply-To': '<original@example.net>', References: '<original@example.net>' },
        attachments: [{ filename: 'data.bin', content: 'AAH/', type: 'application/octet-stream', disposition: 'attachment' }],
      })
    }
    expect(send).toHaveBeenCalledOnce()
  })
})
