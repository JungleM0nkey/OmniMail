import { request } from '../../shared/api/api-client'
import type { MessageDetail, MessageSummary, PageInfo } from '../../shared/api/api-types'

export type Folder = 'inbox' | 'starred' | 'sent' | 'trash'

export const FOLDERS: { value: Folder; label: string }[] = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'starred', label: 'Starred' },
  { value: 'sent', label: 'Sent' },
  { value: 'trash', label: 'Trash' },
]

export interface SharedMailbox {
  address: string
  members: { email: string; displayName: string }[]
  unread: number
}

export interface Attachment {
  id: string
  name: string
  url: string
  /** Set for images the server will render inline; they open in a lightbox. */
  previewUrl: string | null
}

export interface ThreadMessage {
  id: string
  sender: string
  senderEmail: string
  receivedFull: string
  body: string[]
  attachments?: Attachment[]
}

export interface Conversation extends Record<string, unknown> {
  id: string
  sender: string
  senderEmail: string
  subject: string
  preview: string
  /** Short form for the row; the pane shows `receivedFull`. */
  receivedAt: string
  receivedFull: string
  isUnread: boolean
  isStarred: boolean
  folder: MessageSummary['folder']
  /** Only incoming mail can be answered. */
  canReply: boolean
  attachmentCount: number
}

const PREVIEWABLE_IMAGE = /^image\/(avif|gif|jpeg|png|webp)$/i

const shortTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function receivedAt(date: number): string {
  const then = new Date(date)
  const today = new Date()
  if (then.toDateString() === today.toDateString()) return shortTime.format(then)
  today.setDate(today.getDate() - 1)
  if (then.toDateString() === today.toDateString()) return 'Yesterday'
  return shortDate.format(then)
}

function toConversation(message: MessageSummary): Conversation {
  // Sent mail is listed by who it went to, the way every client's Sent folder is.
  const counterpart = message.direction === 'outgoing'
    ? message.recipients.join(', ')
    : message.senderName || message.senderAddress
  return {
    id: message.id,
    sender: counterpart || message.senderAddress,
    senderEmail: message.direction === 'outgoing' ? message.recipients[0] ?? '' : message.senderAddress,
    subject: message.subject,
    preview: message.preview,
    receivedAt: receivedAt(message.date),
    receivedFull: fullDate.format(message.date),
    isUnread: message.direction === 'incoming' && !message.isRead,
    isStarred: message.isStarred,
    folder: message.folder,
    canReply: message.direction === 'incoming',
    attachmentCount: message.attachmentCount,
  }
}

/** Plain text in paragraphs. HTML-only mail is reduced to its text, never rendered. */
function paragraphs(text: string, html: string): string[] {
  const plain = text.trim() || new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() || ''
  return plain.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean)
}

function attachmentUrl(messageId: string, attachmentId: string): string {
  return `/api/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
}

export const sharedMailboxApi = {
  mailboxes: () => request<{ mailboxes: SharedMailbox[] }>('/api/shared-mailboxes'),

  async messages(address: string, folder: Folder, cursor: string | null) {
    const search = new URLSearchParams({ folder })
    if (cursor) search.set('cursor', cursor)
    const result = await request<{ messages: MessageSummary[]; unread: number; page: PageInfo }>(
      `/api/shared-mailboxes/${encodeURIComponent(address)}/messages?${search}`,
    )
    return { conversations: result.messages.map(toConversation), unread: result.unread, page: result.page }
  },

  /** The thread around a message, oldest first, with that message in full. */
  async thread(id: string): Promise<ThreadMessage[]> {
    const { message, thread } = await request<{ message: MessageDetail; thread: MessageSummary[] }>(
      `/api/messages/${encodeURIComponent(id)}`,
    )
    const selected: ThreadMessage = {
      id: message.id,
      sender: message.senderName || message.senderAddress,
      senderEmail: message.senderAddress,
      receivedFull: fullDate.format(message.date),
      body: paragraphs(message.text, message.html),
      attachments: message.attachments
        .filter((attachment) => attachment.disposition !== 'inline')
        .map((attachment) => ({
          id: attachment.id,
          name: attachment.filename,
          url: attachmentUrl(message.id, attachment.id),
          previewUrl: PREVIEWABLE_IMAGE.test(attachment.contentType)
            ? `${attachmentUrl(message.id, attachment.id)}?preview=1`
            : null,
        })),
    }
    // Earlier messages come back as summaries, so they show their preview.
    const messages = thread.map((entry) => entry.id === message.id ? selected : {
      id: entry.id,
      sender: entry.senderName || entry.senderAddress,
      senderEmail: entry.senderAddress,
      receivedFull: fullDate.format(entry.date),
      body: [entry.preview],
    })
    return messages.some((entry) => entry.id === message.id) ? messages : [selected]
  },

  update: (id: string, input: { isRead?: boolean; isStarred?: boolean; folder?: 'inbox' | 'sent' | 'trash' }) => (
    request<{ ok: true }>(`/api/messages/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  ),

  reply: (id: string, text: string) => request<{ message: { id: string } }>(
    `/api/messages/${encodeURIComponent(id)}/reply`,
    { method: 'POST', body: JSON.stringify({ text, idempotencyKey: crypto.randomUUID() }) },
  ),
}
