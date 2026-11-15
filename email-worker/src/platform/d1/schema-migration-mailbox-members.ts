export const MAILBOX_MEMBERS_MIGRATION = '0042_mailbox_members.sql'

export const MAILBOX_MEMBERS_RECOVERY = {
  name: MAILBOX_MEMBERS_MIGRATION,
  statements: [
    `CREATE TABLE IF NOT EXISTS mailbox_members (
  mailbox_address TEXT NOT NULL COLLATE NOCASE REFERENCES mailboxes(address) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (mailbox_address, user_id)
)`,
    'CREATE INDEX IF NOT EXISTS idx_mailbox_members_user ON mailbox_members(user_id)',
  ],
} as const
