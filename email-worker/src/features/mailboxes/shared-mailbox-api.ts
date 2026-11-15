import { normalizeEmail } from '../../shared/http/api-helpers'
import { pageResult, parsePageRequest } from '../../shared/http/pagination'
import {
  SUMMARY_COLUMNS,
  folderConditions,
  messageCursorCondition,
  messageSummary,
  type SummaryRow,
} from '../messages/message-list-api'
import type { Env, SessionUser } from '../../app/types'

type SharedMailboxRow = { address: string; members_json: string; unread: number }

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/** The mailboxes shared with this user, with everyone they are shared with. */
export async function listSharedMailboxes(env: Env, user: SessionUser): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT mm.mailbox_address AS address,
       (SELECT json_group_array(json_object('email', u.email, 'displayName', u.display_name))
          FROM mailbox_members other JOIN users u ON u.id = other.user_id
         WHERE other.mailbox_address = mm.mailbox_address) AS members_json,
       (SELECT COUNT(*) FROM messages m
         WHERE m.mailbox_address = mm.mailbox_address AND m.direction = 'incoming'
           AND m.folder = 'inbox' AND m.is_read = 0) AS unread
       FROM mailbox_members mm
      WHERE mm.user_id = ?
      ORDER BY mm.mailbox_address`,
  ).bind(user.id).all<SharedMailboxRow>()
  return json({
    mailboxes: results.map((row) => ({
      address: row.address,
      members: JSON.parse(row.members_json) as Array<{ email: string; displayName: string }>,
      unread: row.unread,
    })),
  })
}

/** One folder of a shared mailbox, newest first, for its members only. */
export async function listSharedMessages(
  env: Env,
  user: SessionUser,
  rawAddress: string,
  request: Request,
): Promise<Response> {
  const address = normalizeEmail(rawAddress)
  const member = await env.DB.prepare(
    'SELECT 1 AS found FROM mailbox_members WHERE mailbox_address = ? AND user_id = ?',
  ).bind(address, user.id).first<{ found: number }>()
  if (!member) return json({ error: '共享邮箱不存在。' }, 404)

  const pagination = parsePageRequest(request, 2, 50)
  if (!pagination) return json({ error: '分页参数无效，limit 需要在 1–100 之间。' }, 400)
  const folder = new URL(request.url).searchParams.get('folder') || 'inbox'
  const conditions = ['m.mailbox_address = ?', ...folderConditions(folder)]
  const bindings: Array<string | number> = [address]
  if (pagination.cursor) {
    const after = messageCursorCondition(pagination.cursor)
    if (!after) return json({ error: '邮件分页游标无效。' }, 400)
    conditions.push(after.sql)
    bindings.push(...after.bindings)
  }
  const [list, counts] = await env.DB.batch<SummaryRow | { unread: number | null }>([
    env.DB.prepare(
      `SELECT ${SUMMARY_COLUMNS}
         FROM messages m
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.sort_at DESC, m.id DESC
        LIMIT ?`,
    ).bind(...bindings, pagination.limit + 1),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN direction = 'incoming' AND folder = 'inbox' AND is_read = 0
                       THEN 1 ELSE 0 END) AS unread
         FROM messages WHERE mailbox_address = ?`,
    ).bind(address),
  ])
  const result = pageResult(list.results as SummaryRow[], pagination.limit, (row) => [row.sort_time, row.id])
  return json({
    messages: result.items.map(messageSummary),
    unread: (counts.results[0] as { unread: number | null } | undefined)?.unread ?? 0,
    page: result.page,
  })
}
