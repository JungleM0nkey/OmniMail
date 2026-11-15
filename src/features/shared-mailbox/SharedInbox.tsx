/**
 * A mailbox several people read together, as a two-pane triage queue: the
 * table indexes a reading pane, rows act on hover, and read, starred and
 * folder state is shared by every member. Built on the Astryx `table-inbox`
 * page template; its frame, gaps and padding are kept as the template sets them.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { HStack, Layout, LayoutContent, LayoutHeader, LayoutPanel, StackItem, VStack } from '@astryxdesign/core/Layout'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Icon } from '@astryxdesign/core/Icon'
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable'
import { Section } from '@astryxdesign/core/Section'
import { Tab, TabList } from '@astryxdesign/core/TabList'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { useContainerReveal, useMediaQuery } from '@astryxdesign/core/hooks'
import { Table, useTableRowStatus, useTableSelection, useTableSelectionState } from '@astryxdesign/core/Table'
import type { TablePlugin } from '@astryxdesign/core/Table'
import { ArrowPathIcon, EnvelopeOpenIcon, InboxIcon, StarIcon, TrashIcon } from '@heroicons/react/24/outline'

import { ConversationPane } from './ConversationPane'
import { ALIGN_STATUS_GUTTER, STACK_ROWS_BELOW, useInboxColumns, useInboxRows, type ActionId } from './InboxTable'
import { ReplySheet } from './ReplySheet'
import { FOLDERS, sharedMailboxApi, type Conversation, type Folder, type SharedMailbox } from './model'
import { useSharedInbox, useThread, type MessageChange } from './useSharedInbox'

/** Below this the surface cannot hold list and pane side by side; the pane takes it all. */
const SINGLE_SURFACE_BELOW = 900

/** What the pane is worth on arrival: two thirds, leaving the list a third. */
const PANE_DEFAULT_SHARE = 2 / 3

/** The narrowest the list may be dragged. */
const LIST_MIN_WIDTH = 300

/** The narrowest the pane may be dragged. */
const PANE_MIN_WIDTH = 440

/** The tab strip's height, borrowed by the bulk bar that replaces it so the table never moves. */
const SELECTION_BAR_HEIGHT = 37

/**
 * The width of a box, measured before paint and tracked as it changes. A
 * callback ref, because Layout can attach a slot's element after this
 * component's first layout effect has already run.
 */
function useSurfaceWidth() {
  const [node, ref] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!node) return
    const { paddingInlineStart, paddingInlineEnd } = getComputedStyle(node)
    setWidth(node.offsetWidth - parseFloat(paddingInlineStart) - parseFloat(paddingInlineEnd))
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) setWidth(entries[0].contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  return [ref, width] as const
}

/** The change a row action makes; Reply is not a change and opens the composer. */
function actionChange(action: Exclude<ActionId, 'reply'>, item: Conversation): MessageChange {
  if (action === 'star') return { isStarred: !item.isStarred }
  if (action === 'read') return { isRead: item.isUnread }
  if (item.folder === 'trash') return { folder: item.canReply ? 'inbox' : 'sent' }
  return { folder: 'trash' }
}

export function SharedInbox({ mailbox }: { mailbox: SharedMailbox }) {
  const [folder, setFolder] = useState<Folder>('inbox')
  /** `undefined` until the user picks a message; `null` once they close the pane. */
  const [chosenId, setChosenId] = useState<string | null | undefined>(undefined)
  const [replyTo, setReplyTo] = useState<Conversation | null>(null)
  const [isReplyOpen, setIsReplyOpen] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())

  const inbox = useSharedInbox(mailbox.address, folder)
  const visible = inbox.conversations
  const { update } = inbox

  const { selectionConfig } = useTableSelectionState<Conversation>({
    data: visible,
    idKey: 'id',
    selectedKeys,
    setSelectedKeys,
  })

  const reveal = useContainerReveal()
  const [surfaceRef, surfaceWidth] = useSurfaceWidth()
  const isMeasured = surfaceWidth > 0
  const isSingleSurface = isMeasured && surfaceWidth < SINGLE_SURFACE_BELOW

  const defaultOpenId = isSingleSurface ? null : (visible[0]?.id ?? null)
  const openId = chosenId === null
    ? null
    : chosenId !== undefined && visible.some((item) => item.id === chosenId)
      ? chosenId
      : defaultOpenId
  const openConversation = visible.find((item) => item.id === openId) ?? null
  const isPaneFullWidth = isSingleSurface && openId != null
  const openThread = useThread(openId)

  // Only the handle is the user choosing a split; until then the pane follows the surface.
  const hasUserMovedPane = useRef(false)
  const isPlacingPane = useRef(false)
  const onPaneSizeChange = useCallback(() => {
    if (!isPlacingPane.current) hasUserMovedPane.current = true
  }, [])
  const pane = useResizable({
    defaultSize: '58%',
    minSize: PANE_MIN_WIDTH,
    maxSize: isMeasured ? Math.max(PANE_MIN_WIDTH, surfaceWidth - LIST_MIN_WIDTH) : undefined,
    onSizeChange: onPaneSizeChange,
  })
  const { resize: resizePane } = pane
  useLayoutEffect(() => {
    if (hasUserMovedPane.current || !isMeasured) return
    isPlacingPane.current = true
    resizePane(Math.round(surfaceWidth * PANE_DEFAULT_SHARE))
    isPlacingPane.current = false
  }, [isMeasured, surfaceWidth, resizePane])

  const [listRef, listWidth] = useSurfaceWidth()
  const isStacked = listWidth > 0 && listWidth < STACK_ROWS_BELOW
  const isTouch = useMediaQuery('(hover: none)')

  const startReply = useCallback((item: Conversation) => {
    setReplyTo(item)
    setIsReplyOpen(true)
  }, [])

  // Read state is shared, so only a message someone actually chose is marked read —
  // never the one the split layout opens by default.
  const handleOpen = useCallback((item: Conversation) => {
    setChosenId(item.id)
    if (item.isUnread) void update(item, { isRead: true })
  }, [update])

  const handleAction = useCallback((action: ActionId, item: Conversation) => {
    if (action === 'reply') startReply(item)
    else void update(item, actionChange(action, item))
  }, [startReply, update])

  const rowStatus = useTableRowStatus<Conversation>({
    getStatus: useCallback(
      (item: Conversation) => (item.isUnread ? { color: 'accent' as const, label: 'Unread' } : null),
      [],
    ),
  })
  const selection = useTableSelection<Conversation>({
    ...selectionConfig,
    getRowLabel: (item) => `message from ${item.sender}`,
    hasRowHighlight: false,
  })
  const rows = useInboxRows({ openId, onOpen: handleOpen, getContainerProps: reveal.getContainerProps })
  const columns = useInboxColumns({ isStacked, isTouch, reveal, onAction: handleAction })

  // Stacked, the checkbox column goes; selection is kept and comes back on widening.
  const tablePlugins: Record<string, TablePlugin<Conversation>> = isStacked
    ? { rowStatus, rows, gutter: ALIGN_STATUS_GUTTER }
    : { selection, rowStatus, rows, gutter: ALIGN_STATUS_GUTTER }

  const selected = visible.filter((item) => selectedKeys.has(item.id))
  const hasSelection = selected.length > 0 && !isStacked
  const applyToSelected = (change: MessageChange) => {
    for (const item of selected) void update(item, change)
    setSelectedKeys(new Set())
  }
  const bulkActions = [
    { id: 'read', label: 'Mark read', icon: EnvelopeOpenIcon, change: { isRead: true } },
    { id: 'star', label: 'Star', icon: StarIcon, change: { isStarred: true } },
    folder === 'trash'
      ? { id: 'restore', label: 'Restore', icon: InboxIcon, change: { folder: 'inbox' as const } }
      : { id: 'trash', label: 'Move to trash', icon: TrashIcon, change: { folder: 'trash' as const } },
  ]

  const memberNames = mailbox.members.map((member) => member.displayName || member.email).join(', ')
  const renderPane = openConversation == null ? null : (isFullWidth: boolean) => (
    <ConversationPane
      conversation={openConversation}
      thread={openThread.thread}
      error={openThread.error}
      onClose={() => setChosenId(null)}
      onReply={startReply}
      onAction={handleAction}
      isFullWidth={isFullWidth}
    />
  )

  return (
    <>
      <Layout
        ref={surfaceRef}
        height="fill"
        header={
          <LayoutHeader hasDivider={isPaneFullWidth} padding={0}>
            <VStack gap={0}>
              <HStack gap={3} vAlign="center" wrap="wrap" padding={4}>
                <StackItem size="fill">
                  <VStack gap={0.5}>
                    <Heading level={1}>{mailbox.address}</Heading>
                    <Text type="supporting">
                      {inbox.unread} unread · shared with {memberNames}
                    </Text>
                  </VStack>
                </StackItem>
                <Button
                  label="Refresh"
                  variant="ghost"
                  icon={<Icon icon={ArrowPathIcon} size="sm" />}
                  isLoading={inbox.isLoading}
                  onClick={() => void inbox.reload()}
                />
              </HStack>

              {isPaneFullWidth ? null : hasSelection ? (
                /* In the tab strip's place and at its height, so selecting never moves the table. */
                <VStack height={SELECTION_BAR_HEIGHT} vAlign="end" paddingBlockEnd={0.5}>
                  <Section variant="muted" paddingInline={3} paddingBlock={2}>
                    <HStack gap={3} vAlign="center" minHeight={28}>
                      <StackItem size="fill">
                        <HStack gap={1} vAlign="center">
                          {bulkActions.map((action) => (
                            <Button
                              key={action.id}
                              label={action.label}
                              variant="ghost"
                              size="sm"
                              icon={<Icon icon={action.icon} size="sm" />}
                              onClick={() => applyToSelected(action.change)}
                            />
                          ))}
                        </HStack>
                      </StackItem>
                      <HStack gap={3} vAlign="center">
                        <Text type="body">
                          {selected.length} {selected.length === 1 ? 'message' : 'messages'} selected
                        </Text>
                        <Text type="supporting" color="secondary">•</Text>
                        <Button
                          label="Unselect All"
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedKeys(new Set())}
                        />
                      </HStack>
                    </HStack>
                  </Section>
                </VStack>
              ) : (
                /* The 4px inset puts the tab labels on the heading's content line. */
                <VStack paddingInline={1}>
                  <TabList
                    hasDivider
                    value={folder}
                    onChange={(value) => {
                      setFolder(value as Folder)
                      setChosenId(undefined)
                    }}>
                    {FOLDERS.map((option) => (
                      <Tab
                        key={option.value}
                        value={option.value}
                        label={option.label}
                        endContent={
                          option.value !== 'inbox' || inbox.unread === 0 ? undefined : (
                            <Badge
                              variant="neutral"
                              label={
                                <>
                                  {inbox.unread}
                                  <VisuallyHidden> unread</VisuallyHidden>
                                </>
                              }
                            />
                          )
                        }
                      />
                    ))}
                  </TabList>
                </VStack>
              )}
            </VStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent ref={listRef} padding={4} isScrollable>
            {isPaneFullWidth && renderPane ? (
              renderPane(true)
            ) : (
              <VStack gap={4}>
                {inbox.error ? (
                  <Banner
                    status="error"
                    title="The mailbox didn't update"
                    description={inbox.error}
                    endContent={<Button label="Retry" variant="secondary" size="sm" onClick={() => void inbox.reload()} />}
                  />
                ) : null}
                {visible.length === 0 && !inbox.isLoading ? (
                  <VStack padding={6}>
                    <EmptyState
                      title="Nothing here"
                      description={`No messages in ${FOLDERS.find((option) => option.value === folder)?.label}.`}
                      icon={<Icon icon={InboxIcon} size="lg" />}
                      actions={
                        folder === 'inbox' ? undefined : (
                          <Button label="Go to Inbox" variant="secondary" onClick={() => setFolder('inbox')} />
                        )
                      }
                    />
                  </VStack>
                ) : (
                  <Table
                    data={visible}
                    columns={columns}
                    idKey="id"
                    plugins={tablePlugins}
                    density="balanced"
                    dividers="none"
                    hasHover
                    textOverflow="truncate"
                  />
                )}
                {inbox.hasMore ? (
                  <HStack hAlign="center">
                    <Button
                      label="Load older messages"
                      variant="secondary"
                      isLoading={inbox.isLoading}
                      onClick={() => void inbox.loadMore()}
                    />
                  </HStack>
                ) : null}
              </VStack>
            )}
          </LayoutContent>
        }
        end={
          isSingleSurface || !renderPane ? undefined : (
            <>
              {/* Handle before the panel: it drags the panel's inline-start edge. */}
              <ResizeHandle
                direction="horizontal"
                isReversed
                hasDivider
                pillPlacement="end"
                resizable={pane.props}
                label="Resize conversation pane"
              />
              <LayoutPanel resizable={pane.props} padding={0} role="complementary" label="Conversation">
                {renderPane(false)}
              </LayoutPanel>
            </>
          )
        }
      />
      <ReplySheet
        mailbox={mailbox.address}
        conversation={replyTo}
        isOpen={isReplyOpen}
        onOpenChange={setIsReplyOpen}
        onSend={async (item, text) => {
          await sharedMailboxApi.reply(item.id, text)
          if (folder === 'sent') void inbox.reload()
        }}
      />
    </>
  )
}
