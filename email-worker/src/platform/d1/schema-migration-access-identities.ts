export const ACCESS_IDENTITIES_MIGRATION = '0043_access_identities.sql'

export const ACCESS_IDENTITIES_RECOVERY = {
  name: ACCESS_IDENTITIES_MIGRATION,
  statements: [
    `CREATE TABLE IF NOT EXISTS access_identities (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`,
    'CREATE INDEX IF NOT EXISTS idx_access_identities_user ON access_identities(user_id)',
  ],
} as const
