const requireThat = (ok, message) => { if (!ok) throw new Error(message) }
const stable = ({ id, hostname, zone_id, service, enabled, previews_enabled, environment }) =>
  ({ id, hostname, zone_id, service, enabled, previews_enabled, environment: environment ?? '' })
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ordered = (domains) => domains.map(stable).sort((a, b) => a.id.localeCompare(b.id, 'en'))

// Wrangler's worker-scoped records endpoint can transfer an existing domain.
// override_scope:false preserves other origins; the account-level PUT only attaches.
export function domainTransfer({ api, site, originalDomains, listDomains }) {
  const saved = originalDomains.filter((d) => d.hostname === site.hostname)
  requireThat(saved.length === 1 && saved[0].id === site.domain && saved[0].zone_id === site.zone
    && saved[0].service === site.source && typeof saved[0].enabled === 'boolean'
    && typeof saved[0].previews_enabled === 'boolean', 'Invalid saved mail domain identity or flags.')
  const original = saved[0]
  const origin = { hostname: site.hostname, zone_id: site.zone, enabled: original.enabled, previews_enabled: original.previews_enabled }
  const capturedOthers = originalDomains.filter((d) => d.id !== site.domain && [site.source, site.target].includes(d.service))
  const check = (domains) => {
    requireThat(Array.isArray(domains) && domains.every((d) => typeof d?.id === 'string')
      && new Set(domains.map((d) => d.id)).size === domains.length, 'Incomplete custom domain inventory.')
    const matches = domains.filter((d) => d.hostname === site.hostname), current = matches[0]
    requireThat(matches.length === 1 && current.id === site.domain && current.zone_id === site.zone
      && [site.source, site.target].includes(current.service), 'Mail domain identity/ownership changed.')
    requireThat(current.enabled === original.enabled && current.previews_enabled === original.previews_enabled
      && (current.environment ?? '') === (original.environment ?? ''), 'Mail domain routing flags/environment changed.')
    requireThat(capturedOthers.every((old) => domains.some((d) => same(stable(d), stable(old)))), 'Captured unrelated custom domain changed or disappeared.')
    return current
  }
  const done = (domains, worker) => {
    requireThat([site.source, site.target].includes(worker), 'Unexpected domain transfer destination.')
    return check(domains).service === worker
  }
  return { done, apply: async (worker) => {
    const before = await listDomains()
    if (done(before, worker)) return
    const path = `/accounts/${site.account}/workers/scripts/${encodeURIComponent(worker)}/domains`
    const preview = (await api('POST', `${path}/changeset?replace_state=false`, { body: [origin] })).result
    requireThat(preview && ['added', 'removed', 'conflicting'].every((key) => Array.isArray(preview[key]) && preview[key].length === 0)
      && same(preview.affected_zones, [site.zone]) && Array.isArray(preview.updated) && preview.updated.length === 1,
    'Domain transfer preview contains unexpected changes or conflicts.')
    const update = preview.updated[0]
    requireThat(update?.id === site.domain && update.hostname === site.hostname && update.zone_id === site.zone
      && update.service === worker && update.enabled === origin.enabled && update.previews_enabled === origin.previews_enabled
      && update.modified === true, 'Domain transfer preview identity or routing flags mismatch.')
    const fresh = await listDomains(); check(fresh)
    requireThat(same(ordered(before), ordered(fresh)), 'Custom domains changed during transfer preview; retry after review.')
    await api('PUT', `${path}/records`, { body: {
      override_scope: false, override_existing_origin: true, override_existing_dns_record: false, origins: [origin],
    } })
    const after = await listDomains()
    requireThat(done(after, worker), 'Domain transfer did not reach its expected owner.')
    requireThat(same(ordered(before.filter((d) => d.id !== site.domain)), ordered(after.filter((d) => d.id !== site.domain))),
      'Unrelated custom domains changed during transfer.')
  } }
}
