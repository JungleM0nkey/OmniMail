import test from 'node:test'
import assert from 'node:assert/strict'
import { list, SITE } from './apehost-cutover.mjs'

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
