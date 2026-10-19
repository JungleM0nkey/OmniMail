import test from 'node:test'
import assert from 'node:assert/strict'
import { SITE, step } from './apehost-cutover.mjs'
import { domainTransfer } from './apehost-domain-transfer.mjs'

const A = `/accounts/${SITE.account}`
const copy = (value) => structuredClone(value)
const domain = { id: SITE.domain, hostname: SITE.hostname, zone_id: SITE.zone, service: SITE.source,
  environment: 'production', cert_id: 'existing-cert', enabled: true, previews_enabled: false }

function fixture(flags = {}) {
  const domains = [{ ...domain, ...flags },
    { ...domain, id: 'stage', hostname: SITE.stage, service: SITE.target },
    { ...domain, id: 'source-other', hostname: 'other-source.apehost.dev' },
    { ...domain, id: 'foreign', hostname: 'unrelated.apehost.dev', service: 'unrelated-worker' }]
  const originalDomains = copy(domains), calls = [], saved = [], plans = []
  const state = { started: {}, completed: {} }
  const f = { domains, originalDomains, calls, saved, plans, state, loseResponse: false, failBeforeWrite: false }
  const listDomains = async () => { calls.push({ method: 'GET', path: `${A}/workers/domains` }); return copy(domains) }
  const api = async (method, path, { body } = {}) => {
    calls.push({ method, path, body: copy(body) })
    if (method === 'PUT' && path === `${A}/workers/domains`) throw new Error('HTTP 409 code 100116')
    const match = path.match(/\/workers\/scripts\/(mailflare|omni-mail)\/domains\/(changeset\?replace_state=false|records)$/)
    assert.ok(match, 'Only the exact worker-scoped domain endpoints may be called')
    const worker = match[1], current = domains.find((d) => d.hostname === SITE.hostname)
    if (method === 'POST') {
      assert.equal(match[2], 'changeset?replace_state=false')
      assert.deepEqual(body, [{ hostname: SITE.hostname, zone_id: SITE.zone,
        enabled: originalDomains[0].enabled, previews_enabled: originalDomains[0].previews_enabled }])
      const preview = { added: [], updated: [{ ...copy(current), ...body[0], service: worker,
        environment: '', cert_id: '', modified: true }], removed: [], conflicting: [], affected_zones: [SITE.zone] }
      f.onPreview?.(preview, domains)
      return { result: preview }
    }
    assert.equal(method, 'PUT'); assert.equal(match[2], 'records')
    assert.deepEqual(body, { override_scope: false, override_existing_origin: true,
      override_existing_dns_record: false, origins: [{ hostname: SITE.hostname, zone_id: SITE.zone,
        enabled: originalDomains[0].enabled, previews_enabled: originalDomains[0].previews_enabled }] })
    if (f.failBeforeWrite) { f.failBeforeWrite = false; throw new Error('HTTP 409 concurrent origin change') }
    Object.assign(current, body.origins[0], { service: worker })
    f.onWrite?.(domains)
    if (f.loseResponse) { f.loseResponse = false; throw new Error('simulated lost domain response') }
    return { result: {} }
  }
  f.api = api
  f.transfer = domainTransfer({ api, site: SITE, originalDomains, listDomains })
  f.run = (worker, execute = true) => step(state, `${worker}-domain`, { execute, plans,
    saveState: () => saved.push(copy(state)), apply: () => f.transfer.apply(worker),
    done: async () => f.transfer.done(await listDomains(), worker) })
  return f
}

test('worker-scoped transfer replaces the failing attach contract in both directions and preserves every other domain', async () => {
  for (const flags of [{ enabled: true, previews_enabled: false }, { enabled: true, previews_enabled: true }, { enabled: false, previews_enabled: true }]) {
    const f = fixture(flags), others = copy(f.domains.slice(1))
    await assert.rejects(f.api('PUT', `${A}/workers/domains`, { body: { hostname: SITE.hostname, service: SITE.target } }), /409.*100116/)
    await f.run(SITE.target)
    assert.equal(f.domains[0].service, SITE.target); assert.equal(f.domains[0].id, SITE.domain)
    assert.deepEqual(f.domains.slice(1), others)
    await f.run(SITE.source)
    assert.deepEqual(f.domains, f.originalDomains)
    assert.equal(f.calls.filter((c) => c.method === 'POST').length, 2)
    assert.ok(!f.calls.some((c) => c.method === 'DELETE'))
  }
})

test('preview refuses additions, removals, conflicts, extra zones and mismatched immutable identity or flags', async () => {
  for (const change of [
    (p) => { p.added = [{}] }, (p) => { p.removed = [{ id: 'stage' }] }, (p) => { p.conflicting = [{}] },
    (p) => { delete p.added }, (p) => { p.affected_zones = [] }, (p) => { p.affected_zones.push('other-zone') },
    (p) => { p.updated = [] }, (p) => { p.updated.push(copy(p.updated[0])) },
    ...['id', 'hostname', 'zone_id', 'service', 'enabled', 'previews_enabled', 'modified'].map((key) =>
      (p) => { p.updated[0][key] = typeof p.updated[0][key] === 'boolean' ? !p.updated[0][key] : 'unexpected' }),
  ]) {
    const f = fixture(); f.onPreview = change
    await assert.rejects(f.run(SITE.target), /preview/)
    assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 0)
    assert.deepEqual(f.domains, f.originalDomains); assert.equal(f.state.completed[`${SITE.target}-domain`], undefined)
  }
})

test('wrong owner, identity, routing flags, environment or ambiguous inventory refuses before preview and writes', async () => {
  for (const change of [
    (d) => { d[0].service = 'foreign-owner' }, (d) => { d[0].id = 'recreated-domain' },
    (d) => { d[0].zone_id = 'wrong-zone' }, (d) => { d[0].enabled = false },
    (d) => { delete d[0].previews_enabled }, (d) => { d[0].environment = 'other-environment' },
    (d) => { d.push({ ...d[0], id: 'duplicate-host' }) }, (d) => { d.pop(); d.push(copy(d[1])) },
    (d) => { d[1].service = 'changed-stage-owner' },
  ]) {
    const f = fixture(); change(f.domains)
    await assert.rejects(f.run(SITE.target), /identity|ownership|flags|environment|inventory|unrelated/)
    assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0)
  }
})

test('fresh post-preview observation catches owner, flag and unrelated-domain races before PUT', async () => {
  for (const change of [
    (d) => { d[0].service = 'foreign-owner' }, (d) => { d[0].service = SITE.target },
    (d) => { d[0].previews_enabled = true }, (d) => { d[1].service = 'foreign-owner' },
    (d) => { d.push({ ...domain, id: 'new-domain', hostname: 'new.apehost.dev' }) },
  ]) {
    const f = fixture(); f.onPreview = (_preview, domains) => change(domains)
    await assert.rejects(f.run(SITE.target), /ownership|flags|unrelated|changed during/)
    assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 0)
  }
})

test('certificate renewal and preview placeholders do not become ownership comparisons', async () => {
  const f = fixture()
  f.onPreview = (_preview, domains) => { domains[0].cert_id = 'renewed-cert'; domains[1].cert_id = 'renewed-stage-cert' }
  await f.run(SITE.target)
  assert.equal(f.domains[0].cert_id, 'renewed-cert'); assert.equal(f.domains[1].cert_id, 'renewed-stage-cert')
  assert.equal(f.domains[0].environment, 'production')
})

test('post-transfer owner, flag and unrelated-domain failures never mark the intent complete', async () => {
  for (const change of [
    (d) => { d[0].service = 'foreign-owner' }, (d) => { d[0].enabled = false },
    (d) => { d[0].id = 'recreated-domain' }, (d) => { d.splice(1, 1) },
    (d) => { d[3].previews_enabled = true },
  ]) {
    const f = fixture(); f.onWrite = change
    await assert.rejects(f.run(SITE.target), /ownership|identity|flags|unrelated|Unrelated/)
    assert.equal(f.state.started[`${SITE.target}-domain`], true)
    assert.equal(f.state.completed[`${SITE.target}-domain`], undefined)
    assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1)
    await assert.rejects(f.run(SITE.target), /ownership|identity|flags|unrelated|Unrelated/)
    assert.equal(f.state.completed[`${SITE.target}-domain`], undefined)
    assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1)
  }
})

test('domains added after preparation refuse before preview and cannot establish an unrecorded retry baseline', async () => {
  for (const service of [SITE.source, SITE.target, 'foreign-worker']) {
    const f = fixture()
    f.domains.push({ ...domain, id: 'added-after-prepare', hostname: 'new.apehost.dev', service })
    await assert.rejects(f.run(SITE.target), /unrelated/)
    assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0)
    assert.equal(f.state.completed[`${SITE.target}-domain`], undefined)
  }
})

test('lost responses in cutover and rollback resume by exact identity and flags without repeating a write', async () => {
  const f = fixture()
  for (const worker of [SITE.target, SITE.source]) {
    f.loseResponse = true
    await assert.rejects(f.run(worker), /lost domain response/)
    assert.equal(f.state.started[`${worker}-domain`], true)
    assert.equal(f.state.completed[`${worker}-domain`], undefined)
    const before = f.calls.filter((c) => c.method !== 'GET').length
    await f.run(worker); await f.run(worker)
    assert.equal(f.calls.filter((c) => c.method !== 'GET').length, before)
    assert.equal(f.state.completed[`${worker}-domain`], true)
    assert.deepEqual(f.domains.slice(1), f.originalDomains.slice(1))
  }
})

test('rejected transfer retries a fresh preview while dryrun plans without preview or mutations', async () => {
  const f = fixture(), state = copy(f.state)
  await f.run(SITE.target, false)
  assert.deepEqual(f.state, state); assert.deepEqual(f.plans, [`${SITE.target}-domain`])
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0)
  f.failBeforeWrite = true
  await assert.rejects(f.run(SITE.target), /409/)
  assert.deepEqual(f.domains, f.originalDomains)
  await f.run(SITE.target)
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 2)
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 2)
})

test('a lost response with changed flags or a removed sibling remains refused on retry', async () => {
  for (const change of [(d) => { d[0].previews_enabled = true }, (d) => { d.splice(1, 1) }]) {
    const f = fixture(); f.loseResponse = true
    await assert.rejects(f.run(SITE.target), /lost domain response/)
    change(f.domains)
    await assert.rejects(f.run(SITE.target), /flags|unrelated/)
    assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1)
  }
})
