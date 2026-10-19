import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SITE, readSnapshot } from './apehost-cutover.mjs'

const scratch = resolve(process.platform === 'win32' ? 'D:/omnimail-resume-20261018/tmp' : tmpdir())
mkdirSync(scratch, { recursive: true })
function input(t) {
  const directory = mkdtempSync(join(scratch, 'baseline-test-')), path = join(directory, 'snapshot.json')
  t.after(() => { assert.ok(directory.startsWith(`${scratch}\\`) || directory.startsWith(`${scratch}/`)); rmSync(directory, { recursive: true, force: true }) })
  const tables = Object.fromEntries(['messages', 'message_attachments', 'mailboxes', 'domains'].map((name) => [name, []]))
  const schema = Object.keys(tables).sort().map((name) => ({ type: 'table', name, tbl_name: name, sql: `CREATE TABLE ${name} (...)` }))
  const data = { createdAt: '2026-10-19T00:00:00Z', account: SITE.account, database: SITE.database, bucket: SITE.bucket, schema, tables, objects: [] }
  return { data, read: () => { writeFileSync(path, JSON.stringify(data)); return readSnapshot(path) } }
}

test('captured snapshots require complete typed schema and exact table coverage', (t) => {
  for (const change of [
    (d) => { delete d.schema }, (d) => { d.schema = d.schema.map(({ name, sql }) => ({ name, sql })) },
    (d) => { d.schema.push(d.schema[0]) }, (d) => { d.schema[0].type = 'unknown' },
    (d) => { d.schema[0].sql = undefined }, (d) => { d.tables.missing_schema_table = [] },
    (d) => { d.schema.push({ type: 'table', name: 'omitted_rows', tbl_name: 'omitted_rows', sql: 'CREATE TABLE omitted_rows (...)' }) },
    (d) => { d.tables.messages = [null] },
  ]) { const f = input(t); change(f.data); assert.throws(f.read, /schema|coverage|captured D1/i) }
})

test('captured schema retains index, trigger and view definitions without claiming table rows for them', (t) => {
  const f = input(t)
  f.data.schema.push({ type: 'index', name: 'idx_messages', tbl_name: 'messages', sql: 'CREATE INDEX idx_messages ON messages(id)' },
    { type: 'trigger', name: 'message_trigger', tbl_name: 'messages', sql: 'CREATE TRIGGER message_trigger ...' },
    { type: 'view', name: 'message_view', tbl_name: 'message_view', sql: 'CREATE VIEW message_view AS SELECT * FROM messages' })
  assert.deepEqual(f.read().data.schema, f.data.schema)
})
