import { describe, expect, it } from 'vitest'
import { safeReturnPath, verifyAccessJwt } from './access-login'

const TEAM = 'team.cloudflareaccess.com'
const AUD = 'app-audience'
const NOW = 1_800_000_000

function base64Url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  return btoa(String.fromCharCode(...raw)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function signer() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' }
  const sign = async (claims: Record<string, unknown>, kid = 'k1') => {
    const head = base64Url(JSON.stringify({ alg: 'RS256', kid }))
    const body = base64Url(JSON.stringify(claims))
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`))
    return `${head}.${body}.${base64Url(new Uint8Array(signature))}`
  }
  return { sign, fetchKeys: async () => [jwk] }
}

const valid = { iss: `https://${TEAM}`, aud: [AUD], exp: NOW + 60, nbf: NOW - 60, email: 'Dev@Example.com' }

describe('Cloudflare Access JWT', () => {
  it('accepts only a token signed by the team for this application, while valid', async () => {
    const { sign, fetchKeys } = await signer()
    const verify = (token: string) => verifyAccessJwt(token, { teamDomain: TEAM, audience: AUD, now: NOW, fetchKeys })

    expect(await verify(await sign(valid))).toBe('dev@example.com')
    expect(await verify(await sign({ ...valid, aud: ['other-app'] }))).toBeNull()
    expect(await verify(await sign({ ...valid, iss: 'https://other.cloudflareaccess.com' }))).toBeNull()
    expect(await verify(await sign({ ...valid, exp: NOW - 1 }))).toBeNull()
    expect(await verify(await sign({ ...valid, nbf: NOW + 60 }))).toBeNull()
    expect(await verify(await sign(valid, 'unknown-kid'))).toBeNull()

    const [head, , signature] = (await sign(valid)).split('.')
    const forged = base64Url(JSON.stringify({ ...valid, email: 'attacker@example.com' }))
    expect(await verify(`${head}.${forged}.${signature}`)).toBeNull()
  })

  it('returns only same-origin paths', () => {
    expect(safeReturnPath('/shared/admin%40example.com')).toBe('/shared/admin%40example.com')
    expect(safeReturnPath('//evil.example')).toBe('/')
    expect(safeReturnPath('/\\evil.example')).toBe('/')
    expect(safeReturnPath('https://evil.example')).toBe('/')
    expect(safeReturnPath(null)).toBe('/')
  })
})
