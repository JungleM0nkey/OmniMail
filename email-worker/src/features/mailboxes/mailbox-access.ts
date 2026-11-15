/**
 * Who may read and act on a mailbox's mail: its owner, or a member it is
 * shared with (`mailbox_members`). `mb` is the alias of the joined `mailboxes`
 * row. Bind the user id twice, once per placeholder.
 *
 * Ownership-only operations — permanent deletion, quota, mailbox settings —
 * keep checking `user_id` directly, because their accounting is the owner's.
 */
export function mailboxAccessSql(mb = 'mb'): string {
  return `(${mb}.user_id = ? OR EXISTS (
    SELECT 1 FROM mailbox_members mm
     WHERE mm.mailbox_address = ${mb}.address AND mm.user_id = ?
  ))`
}
