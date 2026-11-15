import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import { Theme } from '@astryxdesign/core/theme'
import { VStack } from '@astryxdesign/core/Layout'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Spinner } from '@astryxdesign/core/Spinner'

import { api, AUTH_REQUIRED_EVENT } from '../../shared/api/api-client'
import { signInAndReturn } from '../../shared/auth/returnPath'
import { defaultThemeSlug, themes } from '../../astryx-themes'
import { SharedInbox } from './SharedInbox'
import { sharedMailboxApi, type SharedMailbox } from './model'

/** `/shared/<address>`; `/shared` alone opens the first mailbox shared with you. */
function requestedAddress(): string {
  return decodeURIComponent(window.location.pathname.replace(/^\/shared\/?/, '')).toLowerCase()
}

/** The main app owns sign-in; it sends the user back here afterwards. */
function signIn() {
  signInAndReturn(window.location.pathname)
}

function SharedMailboxPage() {
  const [mailboxes, setMailboxes] = useState<SharedMailbox[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.addEventListener(AUTH_REQUIRED_EVENT, signIn)
    api.session()
      .then(({ user }) => user ? sharedMailboxApi.mailboxes() : (signIn(), null))
      .then((result) => { if (result) setMailboxes(result.mailboxes) })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : String(loadError)))
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, signIn)
  }, [])

  const mailbox = mailboxes?.find((entry) => entry.address === requestedAddress()) ?? mailboxes?.[0]
  useEffect(() => {
    if (mailbox && requestedAddress() !== mailbox.address) {
      window.history.replaceState(null, '', `/shared/${encodeURIComponent(mailbox.address)}`)
    }
  }, [mailbox])

  if (mailbox) return <SharedInbox key={mailbox.address} mailbox={mailbox} />
  return (
    <VStack padding={6} hAlign="center">
      {error ? (
        <EmptyState title="Couldn't open shared mail" description={error} />
      ) : mailboxes == null ? (
        <Spinner label="Loading shared mailboxes" />
      ) : (
        <EmptyState title="No shared mailboxes" description="No mailbox has been shared with your account." />
      )}
    </VStack>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* OmniMail's light/dark choice: public/theme-init.js sets it on <html> before this loads. */}
    <Theme theme={themes[defaultThemeSlug]} mode={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}>
      <SharedMailboxPage />
    </Theme>
  </StrictMode>,
)
