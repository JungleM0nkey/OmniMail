/**
 * The queue half of the shared inbox: columns, row behaviour and the
 * timestamp that row actions replace on hover. Adapted from the Astryx
 * `table-inbox` template; its reasoning is kept where it explains a number.
 */

import { useMemo } from 'react'

import { HStack, StackItem, VStack } from '@astryxdesign/core/Layout'
import { Avatar } from '@astryxdesign/core/Avatar'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Text } from '@astryxdesign/core/Text'
import { pixel, proportional } from '@astryxdesign/core/Table'
import type { TableColumn, TablePlugin } from '@astryxdesign/core/Table'
import type { UseContainerRevealReturn } from '@astryxdesign/core/hooks'
import {
  ArrowUturnLeftIcon,
  ArrowUturnUpIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  PaperClipIcon,
  StarIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'

import type { Conversation } from './model'

/** Dwell before row actions appear, so a cursor sweeping the list stays quiet. */
const HOVER_INTENT_MS = 90

/** Matches the wash the selection plugin paints, so both states look native. */
const OPEN_CELL_STYLE = { backgroundColor: 'var(--color-accent-muted)' }

/** Below this much room for the table, the columns stop earning their keep and rows stack. */
export const STACK_ROWS_BELOW = 560

// ============= ROW ACTIONS =============

export type ActionId = 'star' | 'read' | 'trash' | 'reply'

export interface RowAction {
  id: ActionId
  label: string
  icon: typeof StarIcon
}

/**
 * What can be done to a message from its row. Labels follow its state, so the
 * same slot reads "Star" or "Unstar". Reply only exists for incoming mail.
 */
export function rowActions(item: Conversation, isNarrow = false): RowAction[] {
  const actions: RowAction[] = [
    { id: 'star', label: item.isStarred ? 'Unstar' : 'Star', icon: StarIcon },
    item.isUnread
      ? { id: 'read', label: 'Mark read', icon: EnvelopeOpenIcon }
      : { id: 'read', label: 'Mark unread', icon: EnvelopeIcon },
    item.folder === 'trash'
      ? { id: 'trash', label: 'Restore', icon: ArrowUturnUpIcon }
      : { id: 'trash', label: 'Move to trash', icon: TrashIcon },
  ]
  if (item.canReply) actions.push({ id: 'reply', label: 'Reply', icon: ArrowUturnLeftIcon })
  // Two buttons is all a stacked row can spend before the subject pays for it.
  return isNarrow ? actions.filter((action) => action.id === 'star' || action.id === 'trash') : actions
}

const MAX_ROW_ACTIONS = 4
const NARROW_ROW_ACTIONS = 2

/** A `size="sm"` IconButton is 28px; `gap={0.5}` is 2px. */
function actionsWidth(count: number): number {
  return count * 28 + (count - 1) * 2
}

/** `density="balanced"` insets a table cell by 12px on each inline edge. */
const CELL_INSET = 24

/** Status gutter re-sized to 16px of inset, the 8px dot and 12px after it. */
const STATUS_GUTTER_WIDTH = 36

/** Internal to `useTableRowStatus`; if renamed this quietly stops applying. */
const STATUS_COLUMN_KEY = '__rowStatus'

export const ALIGN_STATUS_GUTTER: TablePlugin<Conversation> = {
  transformColumns: (columns) =>
    columns.map((column) =>
      column.key === STATUS_COLUMN_KEY
        ? { ...column, width: pixel(STATUS_GUTTER_WIDTH) }
        : column,
    ),
}

/** Room for "Yesterday" plus the star and attachment glyphs and their gaps. */
const TIMESTAMP_WIDTH = 76 + 2 * (16 + 4)

/** Overlaid, actions and timestamp share one box; side by side, both are paid for. */
function trailingWidth(actionCount: number, isSideBySide: boolean): number {
  const actions = actionsWidth(actionCount)
  return isSideBySide
    ? actions + 4 + TIMESTAMP_WIDTH + CELL_INSET
    : Math.max(actions, TIMESTAMP_WIDTH) + CELL_INSET
}

/** The actions take the whole cell once they enter flow, displacing the timestamp. */
const ACTIONS_CLAIM_CELL = { flexBasis: '100%', flexShrink: 0 }

/** Clips the attachment glyph the actions squeeze out of the trailing box. */
const HIDE_SQUEEZED_CONTENT = { overflow: 'hidden' }

/**
 * The timestamp, and the actions that take its place on hover. Visibility
 * comes from `useContainerReveal` (the row is the container), so hovering
 * re-renders nothing; keyboard focus and touch reveal the actions too.
 */
function ReceivedCell({
  item,
  isNarrow,
  reveal,
  isOverlaid,
  onAction,
}: {
  item: Conversation
  isNarrow: boolean
  reveal: UseContainerRevealReturn
  /** False on touch, where the actions stay up and share the row instead. */
  isOverlaid: boolean
  onAction: (action: ActionId, item: Conversation) => void
}) {
  return (
    <HStack gap={1} vAlign="center" hAlign="end" height={28}>
      <HStack
        {...reveal.getContentRevealProps()}
        style={isOverlaid ? ACTIONS_CLAIM_CELL : undefined}
        gap={0.5}
        vAlign="center"
        hAlign="end">
        {rowActions(item, isNarrow).map((action) => (
          <IconButton
            key={action.id}
            variant="ghost"
            size="sm"
            label={`${action.label} — ${item.subject}`}
            tooltip={action.label}
            icon={<Icon icon={action.icon} size="sm" />}
            onClick={() => onAction(action.id, item)}
          />
        ))}
      </HStack>
      <StackItem size="fill">
        <HStack
          {...(isOverlaid ? {} : reveal.getContentRevealProps({ isRevealInverted: true }))}
          style={HIDE_SQUEEZED_CONTENT}
          gap={1}
          vAlign="center"
          hAlign="end">
          {item.isStarred ? <Icon icon={StarIcon} size="sm" color="gray" label="Starred" /> : null}
          {item.attachmentCount === 0 ? null : (
            <Icon icon={PaperClipIcon} size="sm" color="gray" label="Has attachments" />
          )}
          <Text
            color="secondary"
            hasTabularNumbers
            justify="end"
            maxLines={1}
            hasTruncateTooltip={false}
            weight={item.isUnread ? 'semibold' : 'normal'}>
            {item.receivedAt}
          </Text>
        </HStack>
      </StackItem>
    </HStack>
  )
}

// ============= ROW BEHAVIOUR =============

/** Controls inside the row that are not the row itself. */
const INTERACTIVE_WITHIN_ROW =
  'button, input, a, label, [role="checkbox"], [role="button"], [role="menuitem"]'

function isRowItself(event: { target: EventTarget | null }): boolean {
  return !(event.target as HTMLElement | null)?.closest(INTERACTIVE_WITHIN_ROW)
}

/**
 * Makes each row a doorway and a reveal container at once. The open row is
 * painted on its cells, because the selection plugin owns the row background.
 */
export function useInboxRows({
  openId,
  onOpen,
  getContainerProps,
}: {
  openId: string | null
  onOpen: (item: Conversation) => void
  getContainerProps: UseContainerRevealReturn['getContainerProps']
}): TablePlugin<Conversation> {
  return useMemo(
    () => ({
      transformBodyRow: (props, item) => {
        const container = getContainerProps({ hoverDelay: HOVER_INTENT_MS })
        return {
          ...props,
          htmlProps: {
            ...props.htmlProps,
            className: [props.htmlProps.className, container.className].filter(Boolean).join(' '),
            style: { ...props.htmlProps.style, ...container.style },
            tabIndex: 0,
            'aria-current': item.id === openId ? true : undefined,
            onClick: (event) => {
              if (isRowItself(event)) onOpen(item)
            },
            onKeyDown: (event) => {
              if ((event.key !== 'Enter' && event.key !== ' ') || !isRowItself(event)) return
              event.preventDefault()
              onOpen(item)
            },
          },
        }
      },
      transformBodyCell: (props, _column, item) =>
        item.id === openId
          ? { ...props, htmlProps: { ...props.htmlProps, style: { ...props.htmlProps.style, ...OPEN_CELL_STYLE } } }
          : props,
    }),
    [getContainerProps, onOpen, openId],
  )
}

// ============= COLUMNS =============

export function useInboxColumns({
  isStacked,
  isTouch,
  reveal,
  onAction,
}: {
  isStacked: boolean
  isTouch: boolean
  reveal: UseContainerRevealReturn
  onAction: (action: ActionId, item: Conversation) => void
}): TableColumn<Conversation>[] {
  return useMemo(() => {
    const received: TableColumn<Conversation> = {
      key: 'receivedAt',
      header: 'Received',
      width: pixel(trailingWidth(isStacked ? NARROW_ROW_ACTIONS : MAX_ROW_ACTIONS, isTouch)),
      align: 'end',
      renderCell: (item) => (
        <ReceivedCell
          item={item}
          isNarrow={isStacked}
          reveal={reveal}
          isOverlaid={!isTouch}
          onAction={onAction}
        />
      ),
    }

    if (isStacked) {
      // Stacked, the pair that identifies a message survives: sender over subject.
      return [
        {
          key: 'conversation',
          header: 'Conversation',
          width: proportional(1, { minWidth: 160 }),
          renderCell: (item) => (
            <VStack gap={0.5}>
              <Text maxLines={1} weight={item.isUnread ? 'semibold' : 'normal'}>
                {item.sender}
              </Text>
              <Text maxLines={1} color="secondary">
                {item.subject}
              </Text>
            </VStack>
          ),
        },
        received,
      ]
    }

    return [
      {
        key: 'sender',
        header: 'From',
        width: pixel(190),
        renderCell: (item) => (
          <HStack gap={2} vAlign="center">
            <Avatar name={item.sender} size="sm" tooltip={false} />
            <Text maxLines={1} weight={item.isUnread ? 'semibold' : 'normal'}>
              {item.sender}
            </Text>
          </HStack>
        ),
      },
      {
        key: 'subject',
        header: 'Subject',
        width: proportional(3),
        renderCell: (item) => (
          <HStack gap={2} vAlign="center">
            {/* `static` makes the subject win; the preview is what gives. */}
            <StackItem size="static">
              <Text maxLines={1} weight={item.isUnread ? 'semibold' : 'normal'}>
                {item.subject}
              </Text>
            </StackItem>
            <StackItem size="fill">
              <Text maxLines={1} color="secondary">
                — {item.preview}
              </Text>
            </StackItem>
          </HStack>
        ),
      },
      received,
    ]
  }, [isStacked, isTouch, reveal, onAction])
}
