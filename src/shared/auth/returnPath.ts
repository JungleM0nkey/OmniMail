const KEY = 'omnimail:return-to'

/** Only same-app paths outside the main app come back: today, the shared mailbox page. */
function isReturnPath(path: string | null): path is string {
  return Boolean(path && /^\/shared(\/|$)/.test(path))
}

/** Remembers where to come back to once the main app has signed the user in. */
export function rememberReturnPath(path: string): void {
  try {
    if (isReturnPath(path)) sessionStorage.setItem(KEY, path)
  } catch {
    // Storage blocked: the user lands in the main app instead.
  }
}

/** The remembered path, once; null when there is none. */
export function takeReturnPath(): string | null {
  try {
    const path = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return isReturnPath(path) ? path : null
  } catch {
    return null
  }
}
