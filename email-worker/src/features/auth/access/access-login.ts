import { writeAudit } from '../../../shared/audit/audit'
import { activeUser, createSessionToken, storeSession } from '../session/auth'
import type { Env, UserRow } from '../../../app/types'

type AccessKey = JsonWebKey & { kid?: string }
type KeyFetcher = (teamDomain: string) => Promise<AccessKey[]>

const KEY_CACHE_MS = 60 * 60 * 1000
const keyCache = new Map<string, { fetchedAt: number; keys: AccessKey[] }>()

async function fetchAccessKeys(teamDomain: string): Promise<AccessKey[]> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!response.ok) throw new Error(`Access certs request failed: ${response.status}`)
  return ((await response.json()) as { keys?: AccessKey[] }).keys ?? []
}

async function cachedKeys(teamDomain: string, refresh: boolean, fetchKeys: KeyFetcher): Promise<AccessKey[]> {
  const cached = keyCache.get(teamDomain)
  if (!refresh && cached && Date.now() - cached.fetchedAt < KEY_CACHE_MS) return cached.keys
  const keys = await fetchKeys(teamDomain)
  keyCache.set(teamDomain, { fetchedAt: Date.now(), keys })
  return keys
}

function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function base64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(value)))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * The email in a Cloudflare Access JWT, or null unless the token is signed by
 * the team's current key and is for this application, issued by this team and
 * within its validity window.
 */
export async function verifyAccessJwt(
  token: string,
  options: { teamDomain: string; audience: string; now?: number; fetchKeys?: KeyFetcher },
): Promise<string | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const header = base64UrlJson(parts[0])
  const payload = base64UrlJson(parts[1])
  if (!header || !payload || header.alg !== 'RS256' || typeof header.kid !== 'string') return null

  const fetchKeys = options.fetchKeys ?? fetchAccessKeys
  let key = (await cachedKeys(options.teamDomain, false, fetchKeys)).find((entry) => entry.kid === header.kid)
  // Access rotates keys; an unknown kid earns one fresh fetch.
  key ??= (await cachedKeys(options.teamDomain, true, fetchKeys)).find((entry) => entry.kid === header.kid)
  if (!key) return null

  let signatureValid = false
  try {
    const publicKey = await crypto.subtle.importKey(
      'jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    )
    signatureValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', publicKey, base64UrlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    )
  } catch {
    return null
  }
  if (!signatureValid) return null

  const now = options.now ?? Math.floor(Date.now() / 1000)
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (payload.iss !== `https://${options.teamDomain}`) return null
  if (!audiences.includes(options.audience)) return null
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null
  if (typeof payload.nbf === 'number' && payload.nbf > now) return null
  return typeof payload.email === 'string' && payload.email ? payload.email.toLowerCase() : null
}

/** A same-app path to land on after sign-in; anything else becomes `/`. */
export function safeReturnPath(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/'
}

function text(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

/**
 * Signs in the OmniMail account linked to the Cloudflare Access identity on
 * this request. The route sits behind an Access application, which puts the
 * JWT in `Cf-Access-Jwt-Assertion`; the token is still verified here, so a
 * request that reached the Worker some other way cannot forge it.
 */
export async function accessLogin(
  env: Env,
  request: Request,
  ip: string,
): Promise<{ response: Response; sessionToken?: string }> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return { response: text('Cloudflare Access sign-in is not configured.', 404) }
  }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion')
  const email = assertion
    ? await verifyAccessJwt(assertion, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD })
    : null
  if (!email) {
    await writeAudit(env, null, 'auth.login_failed', null, ip, { channel: 'access', reason: 'invalid_assertion' })
    return { response: text('Cloudflare Access did not vouch for this request.', 401) }
  }

  const user = await env.DB.prepare(
    `SELECT u.* FROM access_identities a JOIN users u ON u.id = a.user_id WHERE a.email = ?`,
  ).bind(email).first<UserRow>()
  if (!user || !activeUser(user, Math.floor(Date.now() / 1000))) {
    await writeAudit(env, null, 'auth.login_failed', email, ip, { channel: 'access', reason: 'unlinked_identity' })
    return { response: text(`No OmniMail account is linked to ${email}.`, 403) }
  }

  const sessionToken = createSessionToken()
  await storeSession(env.DB, user.id, sessionToken)
  await writeAudit(env, user.id, 'auth.login', user.id, ip, { channel: 'access', identity: email })
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get('returnTo'))
  return { response: new Response(null, { status: 302, headers: { Location: returnTo } }), sessionToken }
}
