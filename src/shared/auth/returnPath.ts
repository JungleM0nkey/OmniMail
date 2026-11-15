/**
 * Where to land after signing in: the `returnTo` query parameter when it is a
 * same-app path, else the page itself. Pages outside the main app (the shared
 * mailbox) send users to `/?returnTo=<their path>` to sign in.
 */
export function returnPath(): string {
  const requested = new URLSearchParams(window.location.search).get('returnTo')
  // A path on this origin: one leading slash, never `//host` or `/\host`.
  if (requested && /^\/(?![/\\])/.test(requested)) {
    return requested
  }
  return `${window.location.pathname}${window.location.search}`
}

/** Sends the browser to sign in, coming back to `path` afterwards. */
export function signInAndReturn(path: string): void {
  window.location.assign(`/?returnTo=${encodeURIComponent(path)}`)
}

/** Cloudflare Access sign-in, which lands on `returnPath()` with a session. */
export function accessSignIn(): void {
  window.location.replace(`/api/auth/access?returnTo=${encodeURIComponent(returnPath())}`)
}
