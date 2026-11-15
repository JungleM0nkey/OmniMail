/**
 * The shared mailbox's sidebar, laid out like OmniMail's own: the product at
 * the top, the folders in the middle, the way back to the rest of OmniMail at
 * the bottom.
 */

import { Badge } from '@astryxdesign/core/Badge'
import { Icon } from '@astryxdesign/core/Icon'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import {
  ArrowLeftIcon,
  EnvelopeIcon,
  InboxIcon,
  PaperAirplaneIcon,
  StarIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'

import { FOLDERS, type Folder, type SharedMailbox } from './model'

const FOLDER_ICONS: Record<Folder, typeof InboxIcon> = {
  inbox: InboxIcon,
  starred: StarIcon,
  sent: PaperAirplaneIcon,
  trash: TrashIcon,
}

export function SharedNav({
  mailbox,
  folder,
  unread,
  onFolderChange,
}: {
  mailbox: SharedMailbox
  folder: Folder
  unread: number
  onFolderChange: (folder: Folder) => void
}) {
  return (
    <SideNav
      header={
        <SideNavHeading
          heading="OmniMail"
          headingHref="/mail/inbox"
          subheading={`Shared with ${mailbox.members.map((member) => member.displayName || member.email).join(', ')}`}
          icon={<Icon icon={EnvelopeIcon} size="sm" />}
        />
      }
      footer={<SideNavItem label="Back to my mail" href="/mail/inbox" icon={ArrowLeftIcon} />}>
      <SideNavSection title={mailbox.address}>
        {FOLDERS.map((option) => (
          <SideNavItem
            key={option.value}
            label={option.label}
            icon={FOLDER_ICONS[option.value]}
            isSelected={option.value === folder}
            onClick={() => onFolderChange(option.value)}
            endContent={
              option.value === 'inbox' && unread > 0 ? (
                <Badge
                  variant="neutral"
                  label={
                    <>
                      {unread}
                      <VisuallyHidden> unread</VisuallyHidden>
                    </>
                  }
                />
              ) : undefined
            }
          />
        ))}
      </SideNavSection>
    </SideNav>
  )
}
