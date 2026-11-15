/**
 * The reading pane: one thread, oldest first, with the message the row points
 * at last and already open. Beside the list it is a resizable panel; on a
 * narrow surface it replaces the list. From the Astryx `table-inbox` template.
 */

import { HStack, StackItem, VStack } from '@astryxdesign/core/Layout'
import { rtlStyles } from '@astryxdesign/core/utils'
import { Avatar } from '@astryxdesign/core/Avatar'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'
import { useLightbox } from '@astryxdesign/core/Lightbox'
import { Spinner } from '@astryxdesign/core/Spinner'
import { Thumbnail } from '@astryxdesign/core/Thumbnail'
import { Toolbar } from '@astryxdesign/core/Toolbar'
import { ArrowLeftIcon, ArrowUturnLeftIcon, PaperClipIcon, XMarkIcon } from '@heroicons/react/24/outline'

import { rowActions, type ActionId } from './InboxTable'
import type { Attachment, Conversation, ThreadMessage } from './model'

/** The gap between a message's avatar and the name beside it. */
const THREAD_HEADER_GAP = 3

/** Avatar's default rendered size, which `ThreadGutter` has to match. */
const AVATAR_SIZE = 36

/** How wide a message may get regardless of the pane: a comfortable measure. */
const MESSAGE_MEASURE = 680

/** The avatar's column continued below it, so bodies line up under the name. */
function ThreadGutter() {
  return <VStack width={AVATAR_SIZE} />
}

/** Images as thumbnails opening into a lightbox; other files as download links. */
function AttachmentStrip({ attachments }: { attachments: Attachment[] }) {
  const images = attachments.filter((attachment) => attachment.previewUrl)
  const files = attachments.filter((attachment) => !attachment.previewUrl)
  // Above the empty guard: a hook cannot sit behind an early return.
  const lightbox = useLightbox({
    media: images.map((attachment) => ({
      src: attachment.previewUrl!,
      alt: `Attachment: ${attachment.name}`,
      caption: attachment.name,
    })),
    hasZoom: true,
  })

  if (attachments.length === 0) return null

  return (
    <VStack gap={2}>
      <HStack gap={1} vAlign="center">
        <Icon icon={PaperClipIcon} size="sm" color="gray" />
        <Text type="supporting" color="secondary">
          {attachments.length} attachment{attachments.length === 1 ? '' : 's'}
        </Text>
      </HStack>
      {images.length === 0 ? null : (
        <HStack gap={2} wrap="wrap">
          {images.map((attachment, index) => (
            <Thumbnail
              key={attachment.id}
              src={attachment.previewUrl!}
              alt={`Preview of ${attachment.name}`}
              label={attachment.name}
              onClick={() => lightbox.open(index)}
            />
          ))}
        </HStack>
      )}
      {files.length === 0 ? null : (
        <HStack gap={2} wrap="wrap">
          {files.map((attachment) => (
            <Button
              key={attachment.id}
              label={attachment.name}
              variant="secondary"
              size="sm"
              href={attachment.url}
              icon={<Icon icon={PaperClipIcon} size="sm" />}
            />
          ))}
        </HStack>
      )}
      {lightbox.element}
    </VStack>
  )
}

/** `type="multiple"`: reading a thread is usually comparing two messages. */
function ThreadHistory({ conversationId, messages }: { conversationId: string; messages: ThreadMessage[] }) {
  return (
    <CollapsibleGroup
      // Remount per thread: `defaultValue` is read once.
      key={conversationId}
      type="multiple"
      density="spacious"
      defaultValue={[conversationId]}>
      {messages.map((message) => (
        <Collapsible
          key={message.id}
          value={message.id}
          trigger={
            <HStack gap={THREAD_HEADER_GAP} vAlign="center" paddingInlineEnd={2}>
              <Avatar name={message.sender} tooltip={false} />
              <StackItem size="fill">
                <VStack gap={0.5}>
                  <Text maxLines={1} weight="semibold">
                    {message.sender}
                  </Text>
                  <Text maxLines={1} type="supporting" color="secondary">
                    {message.senderEmail}
                  </Text>
                </VStack>
              </StackItem>
              <Text type="supporting" color="secondary">
                {message.receivedFull}
              </Text>
            </HStack>
          }>
          <HStack gap={THREAD_HEADER_GAP}>
            <ThreadGutter />
            <StackItem size="fill">
              <VStack gap={3} maxWidth={MESSAGE_MEASURE}>
                {message.body.length === 0 ? (
                  <Text color="secondary">(No text content)</Text>
                ) : (
                  message.body.map((paragraph, index) => <Text key={index}>{paragraph}</Text>)
                )}
                <AttachmentStrip attachments={message.attachments ?? []} />
              </VStack>
            </StackItem>
          </HStack>
        </Collapsible>
      ))}
    </CollapsibleGroup>
  )
}

export function ConversationPane({
  conversation,
  thread,
  error,
  onClose,
  onReply,
  onAction,
  isFullWidth,
}: {
  conversation: Conversation
  /** Null while the thread is loading. */
  thread: ThreadMessage[] | null
  error: string | null
  onClose: () => void
  onReply: (conversation: Conversation) => void
  onAction: (action: ActionId, item: Conversation) => void
  /** True when the pane has replaced the list rather than sitting beside it. */
  isFullWidth: boolean
}) {
  // Reply lives under the thread, not in the header: it answers a message.
  const threadActions = rowActions(conversation)
    .filter((action) => action.id !== 'reply')
    .map((action) => (
      <IconButton
        key={action.id}
        variant="ghost"
        label={`${action.label} — ${conversation.subject}`}
        tooltip={action.label}
        icon={<Icon icon={action.icon} size="sm" />}
        onClick={() => onAction(action.id, conversation)}
      />
    ))

  return (
    <VStack height="100%">
      {isFullWidth ? (
        <>
          <Toolbar
            label="Conversation"
            startContent={
              <Button
                label="Inbox"
                variant="ghost"
                icon={<Icon icon={ArrowLeftIcon} size="sm" xstyle={rtlStyles.mirror} />}
                onClick={onClose}
              />
            }
            endContent={threadActions}
          />
          <VStack paddingBlockEnd={3}>
            <Heading level={3} accessibilityLevel={2} maxLines={2} hasTruncateTooltip>
              {conversation.subject}
            </Heading>
          </VStack>
        </>
      ) : (
        /* Uneven inline inset: the title has no side bearing, the close button does. */
        <VStack paddingBlockStart={4} paddingInlineStart={3} paddingInlineEnd={2}>
          <Toolbar
            label="Conversation"
            startContent={
              <Heading level={2} maxLines={2} hasTruncateTooltip>
                {conversation.subject}
              </Heading>
            }
            endContent={
              <>
                {threadActions}
                <IconButton
                  variant="ghost"
                  label="Close conversation"
                  tooltip="Close"
                  icon={<Icon icon={XMarkIcon} size="sm" />}
                  onClick={onClose}
                />
              </>
            }
          />
        </VStack>
      )}

      <StackItem size="fill">
        <VStack
          paddingInline={isFullWidth ? 0 : 6}
          paddingBlockStart={0}
          paddingBlockEnd={isFullWidth ? 0 : 6}
          gap={4}
          isScrollable
          height="100%">
          {error ? (
            <Banner status="error" title="Couldn't load this message" description={error} />
          ) : thread == null ? (
            <HStack hAlign="center" padding={6}>
              <Spinner label="Loading message" />
            </HStack>
          ) : (
            <>
              <ThreadHistory conversationId={conversation.id} messages={thread} />
              {conversation.canReply ? (
                <HStack gap={THREAD_HEADER_GAP}>
                  <ThreadGutter />
                  <Button
                    label="Reply"
                    variant="primary"
                    icon={<Icon icon={ArrowUturnLeftIcon} size="sm" />}
                    onClick={() => onReply(conversation)}
                  />
                </HStack>
              ) : null}
            </>
          )}
        </VStack>
      </StackItem>
    </VStack>
  )
}
