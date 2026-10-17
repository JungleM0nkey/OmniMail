import { DELIVERY_UNCERTAIN_PREFIX, OutboundDeliveryError } from './outbound-errors'
import type { DeliveryPayload } from './outbound-http-provider'

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
    // Cloudflare has no idempotency key, so an uncertain send must not be retried.
    throw new OutboundDeliveryError(
      `${DELIVERY_UNCERTAIN_PREFIX}${error instanceof Error ? error.message : 'Cloudflare send failed'}`,
      false,
      true,
    )
  }
}
