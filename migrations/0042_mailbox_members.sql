-- 共享邮箱：成员与所有者一样可以读取、标记和回复该邮箱的邮件。
CREATE TABLE IF NOT EXISTS mailbox_members (
  mailbox_address TEXT NOT NULL COLLATE NOCASE REFERENCES mailboxes(address) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (mailbox_address, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_members_user ON mailbox_members(user_id);
