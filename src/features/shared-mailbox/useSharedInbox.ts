import { useCallback, useEffect, useState } from 'react'

import { sharedMailboxApi, type Conversation, type Folder, type ThreadMessage } from './model'

export type MessageChange = { isRead?: boolean; isStarred?: boolean; folder?: 'inbox' | 'sent' | 'trash' }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/** What the Inbox badge counts: unread incoming mail still in the inbox. */
function countsAsUnread(item: Conversation): boolean {
  return item.isUnread && item.folder === 'inbox'
}

/** Whether a message still belongs in the folder on screen after a change. */
function belongsIn(item: Conversation, folder: Folder): boolean {
  if (folder === 'starred') return item.isStarred && item.folder !== 'trash'
  return item.folder === folder
}

function applyChange(item: Conversation, change: MessageChange): Conversation {
  return {
    ...item,
    isUnread: change.isRead === undefined ? item.isUnread : item.canReply && !change.isRead,
    isStarred: change.isStarred ?? item.isStarred,
    folder: change.folder ?? item.folder,
  }
}

/** One folder of a shared mailbox, with local updates that the server then confirms. */
export function useSharedInbox(address: string | null, folder: Folder) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [unread, setUnread] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (cursor: string | null = null) => {
    if (!address) return
    setIsLoading(true)
    setError(null)
    try {
      const result = await sharedMailboxApi.messages(address, folder, cursor)
      setConversations((current) => cursor ? [...current, ...result.conversations] : result.conversations)
      setUnread(result.unread)
      setNextCursor(result.page.hasMore ? result.page.nextCursor : null)
    } catch (loadError) {
      setError(errorText(loadError))
    } finally {
      setIsLoading(false)
    }
  }, [address, folder])

  useEffect(() => {
    setConversations([])
    void load()
  }, [load])

  const update = useCallback(async (item: Conversation, change: MessageChange) => {
    const next = applyChange(item, change)
    setUnread((count) => count - Number(countsAsUnread(item)) + Number(countsAsUnread(next)))
    setConversations((current) => belongsIn(next, folder)
      ? current.map((entry) => entry.id === item.id ? next : entry)
      : current.filter((entry) => entry.id !== item.id))
    try {
      await sharedMailboxApi.update(item.id, change)
    } catch (updateError) {
      setError(errorText(updateError))
      void load()
    }
  }, [folder, load])

  return {
    conversations,
    unread,
    isLoading,
    error,
    hasMore: nextCursor != null,
    reload: () => load(),
    loadMore: () => load(nextCursor),
    update,
  }
}

/** The open message's thread, fetched when the open message changes. */
export function useThread(id: string | null) {
  const [thread, setThread] = useState<ThreadMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setThread(null)
    setError(null)
    if (!id) return
    let isCurrent = true
    sharedMailboxApi.thread(id)
      .then((result) => { if (isCurrent) setThread(result) })
      .catch((threadError: unknown) => { if (isCurrent) setError(errorText(threadError)) })
    return () => { isCurrent = false }
  }, [id])

  return { thread, error }
}
