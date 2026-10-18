import { DELIVERY_UNCERTAIN_PREFIX, OutboundDeliveryError } from './outbound-errors'
import type { DeliveryPayload } from './outbound-http-provider'

const REJECTED_CODES = new Set([
  'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE', 'E_RATE_LIMIT_EXCEEDED',
  'E_DAILY_LIMIT_EXCEEDED', 'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY',
])

export async function deliverWithCloudflare(
  email: SendEmail,
  payload: DeliveryPayload,
  senderName: string,
): Promise<string> {
  try {
    const result = await email.send({
      from: { email: payload.replyTo, name: senderName },
      to: payload.to,
      replyTo: payload.replyTo,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      headers: payload.headers,
      attachments: payload.attachments.map((attachment): EmailAttachment => ({
        filename: attachment.filename, content: attachment.content,
        type: attachment.contentType || 'application/octet-stream', disposition: 'attachment',
      })),
    })
    if (!result?.messageId) throw new Error('Cloudflare did not return a message ID')
    return `cloudflare:${result.messageId}`
  } catch (error) {
    const rejected = error instanceof Error && 'code' in error
      && typeof error.code === 'string' && REJECTED_CODES.has(error.code)
    // Cloudflare has no idempotency key, so an uncertain send must not be retried.
    throw new OutboundDeliveryError(
      `${rejected ? '' : DELIVERY_UNCERTAIN_PREFIX}${error instanceof Error ? error.message : 'Cloudflare send failed'}`,
      false,
      !rejected,
    )
  }
}
