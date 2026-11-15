/**
 * The reply sheet, from the Astryx `table-inbox` composer.
 *
 * `hasScrim={false}` keeps it non-modal, so the thread behind it stays
 * readable while writing; `purpose="form"` blocks the scrim tap and downward
 * swipe that would throw a half-written reply away. The server derives the
 * recipient, subject and thread headers from the original message, so the
 * header here is shown, not edited.
 */

import { useCallback, useState } from 'react'

import { Layout, LayoutContent, VStack } from '@astryxdesign/core/Layout'
import { Banner } from '@astryxdesign/core/Banner'
import { BottomSheet } from '@astryxdesign/core/BottomSheet'
import { Button } from '@astryxdesign/core/Button'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'
import { TextArea } from '@astryxdesign/core/TextArea'
import { Toolbar } from '@astryxdesign/core/Toolbar'
import { PaperAirplaneIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline'

import type { Conversation } from './model'

export function ReplySheet({
  mailbox,
  conversation,
  isOpen,
  onOpenChange,
  onSend,
}: {
  mailbox: string
  /** The message being answered; the draft belongs to it. */
  conversation: Conversation | null
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  onSend: (conversation: Conversation, text: string) => Promise<void>
}) {
  const [body, setBody] = useState('')
  const [draftFor, setDraftFor] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A draft survives closing and reopening the same message, never another one.
  if (conversation && conversation.id !== draftFor) {
    setDraftFor(conversation.id)
    setBody('')
    setError(null)
  }

  const discard = useCallback(() => {
    setBody('')
    setError(null)
    onOpenChange(false)
  }, [onOpenChange])

  const send = async () => {
    if (!conversation || !body.trim()) return
    setIsSending(true)
    setError(null)
    try {
      await onSend(conversation, body)
      setBody('')
      onOpenChange(false)
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'The reply was not sent.')
    } finally {
      setIsSending(false)
    }
  }

  const subject = conversation
    ? conversation.subject.startsWith('Re:') ? conversation.subject : `Re: ${conversation.subject}`
    : ''

  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="form"
      label="Reply"
      height="hug"
      hasScrim={false}
      padding={0}>
      <VStack>
        <Layout
          height="auto"
          padding={4}
          defaultHasDividers
          header={
            <Toolbar
              label="Message"
              startContent={<Heading level={2}>Reply</Heading>}
              endContent={
                <IconButton
                  variant="ghost"
                  label="Close composer"
                  tooltip="Close"
                  icon={<Icon icon={XMarkIcon} size="sm" />}
                  onClick={() => onOpenChange(false)}
                />
              }
            />
          }
          content={
            // 12px, to land on the line the header and footer already use.
            <LayoutContent padding={3}>
              <VStack gap={2}>
                {error ? <Banner status="error" title="Reply not sent" description={error} /> : null}
                <Text type="supporting" color="secondary" maxLines={1}>
                  From {mailbox} to {conversation?.sender} &lt;{conversation?.senderEmail}&gt;
                </Text>
                <Text weight="semibold" maxLines={1}>
                  {subject}
                </Text>
                <TextArea
                  label="Message"
                  isLabelHidden
                  placeholder="Write your reply…"
                  value={body}
                  onChange={setBody}
                  rows={8}
                  width="100%"
                />
              </VStack>
            </LayoutContent>
          }
          footer={
            <Toolbar
              label="Message actions"
              dividers={['top']}
              startContent={
                <Button
                  label="Send"
                  variant="primary"
                  icon={<Icon icon={PaperAirplaneIcon} size="sm" />}
                  isLoading={isSending}
                  isDisabled={!body.trim()}
                  onClick={send}
                />
              }
              endContent={
                <IconButton
                  variant="ghost"
                  label="Discard draft"
                  tooltip="Discard draft"
                  icon={<Icon icon={TrashIcon} size="sm" />}
                  onClick={discard}
                />
              }
            />
          }
        />
      </VStack>
    </BottomSheet>
  )
}
