-- Cloudflare Access 登录：Access 身份邮箱映射到 OmniMail 账户；有映射的账户不再接受密码登录。
CREATE TABLE IF NOT EXISTS access_identities (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_access_identities_user ON access_identities(user_id);
