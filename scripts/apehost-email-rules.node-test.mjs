import test from 'node:test'
import assert from 'node:assert/strict'
import { list, step, SITE } from './apehost-cutover.mjs'

const path = `/zones/${SITE.zone}/email/routing/rules`

test('email rule inventory obeys max50 and consumes later pages without total metadata', async () => {
  const pages = []
  const result = await list(async (method, value) => {
    const url = new URL(`https://api.cloudflare.com${value}`), size = Number(url.searchParams.get('per_page'))
    if (size > 50) throw new Error('HTTP 400: per_page cannot be greater than 50')
    assert.equal(method, 'GET'); assert.equal(url.pathname, path); assert.equal(size, 50)
    assert.equal(url.searchParams.has('cursor'), false)
    const page = Number(url.searchParams.get('page')); pages.push(page)
    return { result: page === 1 ? Array.from({ length: 50 }, (_, i) => ({ id: `rule-${i}` })) : [{ id: 'last' }] }
  }, path)
  assert.equal(result.length, 51); assert.equal(result.at(-1).id, 'last'); assert.deepEqual(pages, [1, 2])
})

test('email rule total_count follows short pages and stops exactly at the complete count', async () => {
  const pages = []
  const result = await list(async (_method, value) => {
    const query = new URL(`https://api.cloudflare.com${value}`).searchParams, page = Number(query.get('page'))
    assert.equal(query.get('per_page'), '50'); pages.push(page)
    return { result: [{ id: `rule-${page}` }], result_info: { page, per_page: 50, count: 1, total_count: 3 } }
  }, path)
  assert.equal(result.length, 3); assert.deepEqual(pages, [1, 2, 3])
  let calls = 0
  assert.equal((await list(async () => { calls++; return { result: Array.from({ length: 50 }, (_, id) => ({ id })), result_info: { total_count: 50 } } }, path)).length, 50)
  assert.equal(calls, 1)
})

test('email rule inventory refuses missing rows, changing totals and malformed pagination', async () => {
  for (const bad of [
    { result: [], result_info: { total_count: 1 } },
    { result: [], result_info: { total_count: '0' } },
    { result: [], result_info: { page: 2, total_count: 0 } },
    { result: [], result_info: { count: 1, total_count: 0 } },
  ]) await assert.rejects(list(async () => bad, path), /email rule inventory/i)
  let calls = 0
  await assert.rejects(list(async () => ({ result: [{ id: ++calls }], result_info: { total_count: calls === 1 ? 3 : 4 } }), path), /email rule inventory/i)
})

const A = '/accounts/' + SITE.account, Z = '/zones/' + SITE.zone
const copy = (value) => structuredClone(value)

test('pagination consumes cursors and refuses loops/truncation', async () => {
  const calls = []
  const api = async (_m, path) => { calls.push(path); return path.includes('cursor=next') ? { result: [{ key: 'b' }], result_info: { is_truncated: false } } : { result: [{ key: 'a' }], result_info: { cursor: 'next', is_truncated: true } } }
  assert.equal((await list(api, `${A}/r2/buckets/${SITE.bucket}/objects`)).length, 2); assert.equal(calls.length, 2)
  await assert.rejects(list(async () => ({ result: [], result_info: { is_truncated: true } }), '/objects'), /no cursor/)
  await assert.rejects(list(async () => ({ result: [], result_info: { is_truncated: true, cursor: 'repeat' } }), '/objects'), /Repeated/)
})

test('ruleset inventory obeys its 50-item limit and follows after cursors', async () => {
  const calls = []
  const api = async (method, path) => {
    const url = new URL(`https://api.cloudflare.com${path}`)
    if (Number(url.searchParams.get('per_page')) > 50) throw new Error('HTTP 400: per_page cannot be greater than 50')
    assert.equal(method, 'GET'); assert.equal(url.pathname, `${Z}/rulesets`)
    assert.equal(url.searchParams.get('per_page'), '50'); assert.equal(url.searchParams.has('page'), false)
    calls.push(url.searchParams.get('cursor'))
    return url.searchParams.get('cursor') === 'next+/='
      ? { result: [{ id: 'last-rule' }], result_info: { cursors: { after: '' } } }
      : { result: Array.from({ length: 50 }, (_, i) => ({ id: `rule-${i}` })), result_info: { cursors: { after: 'next+/=' } } }
  }
  const result = await list(api, `${Z}/rulesets`)
  assert.equal(result.length, 51); assert.equal(result.at(-1).id, 'last-rule')
  assert.deepEqual(calls, [null, 'next+/='])
})

test('ruleset pagination honors short pages and refuses repeated after cursors', async () => {
  const api = async (_method, path) => new URL(`https://api.cloudflare.com${path}`).searchParams.has('cursor')
    ? { result: [{ id: 'second' }], result_info: { cursors: {} } }
    : { result: [{ id: 'first' }], result_info: { cursors: { after: 'next' } } }
  assert.deepEqual(await list(api, `${Z}/rulesets`), [{ id: 'first' }, { id: 'second' }])
  await assert.rejects(list(async () => ({ result: [], result_info: { cursors: { after: 'repeat' } } }), `${Z}/rulesets`), /Repeated/)
})

test('queue pages and R2 bucket cursors retain their existing 100-item requests', async () => {
  const pages = []
  const queues = await list(async (_method, path) => {
    const query = new URL(`https://api.cloudflare.com${path}`).searchParams
    assert.equal(query.get('per_page'), '100'); assert.equal(query.has('cursor'), false)
    const page = Number(query.get('page')); pages.push(page)
    return { result: [{ queue_id: `queue-${page}` }], result_info: { total_pages: 2 } }
  }, `${A}/queues`)
  assert.deepEqual(queues.map((q) => q.queue_id), ['queue-1', 'queue-2']); assert.deepEqual(pages, [1, 2])
  const buckets = await list(async (_method, path) => {
    const query = new URL(`https://api.cloudflare.com${path}`).searchParams
    assert.equal(query.get('per_page'), '100')
    return query.has('cursor') ? { result: { buckets: [{ name: 'last' }] }, result_info: {} }
      : { result: { buckets: [{ name: 'first' }] }, result_info: { cursor: 'bucket-next' } }
  }, `${A}/r2/buckets`, 'buckets')
  assert.deepEqual(buckets.map((b) => b.name), ['first', 'last'])
})

test('step records intent before a mutation and skips an already completed operation', async () => {
  const state = { started: {}, completed: {} }, saved = [], plans = []; let present = false, writes = 0
  const options = { execute: true, saveState: () => saved.push(copy(state)), plans, apply: async () => { assert.equal(saved.at(-1).started.one, true); writes++; present = true }, done: async () => present }
  await step(state, 'one', options); await step(state, 'one', options)
  assert.equal(writes, 1); assert.equal(state.completed.one, true)
})
