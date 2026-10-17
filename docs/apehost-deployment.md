# Apehost OmniMail replacement

Status: prepared for review, **not deployed**. Based on upstream OmniMail 1.3.0,
commit `6f765dd`. Mailflare still serves `https://mail.apehost.dev`.

The replacement keeps `m0nkey@apehost.dev`, adds native Cloudflare Email sending
to OmniMail's existing queue, and permits framing by `https://console.apehost.dev`
and the mail origin itself. Other origins remain blocked. Authentication, message
ownership checks, outbound rate limits, private attachments and email-content
framing restrictions retain their existing implementation.

Cloudflare is a fallback when no Resend or SendFlare provider is configured.
Replies preserve threading headers and attachments. An uncertain send is never
automatically retried, including when Cloudflare accepts mail but D1 cannot record
it. Cloudflare's own message-size and sending limits still apply.

## Resources

Account: `7031244e5dbce80f897a55df4b7c859b`.

| Resource | Existing Mailflare | New OmniMail |
| --- | --- | --- |
| Worker | `mailflare` | `omni-mail` |
| D1 | `9e15235d-7c72-435e-8a76-09cc9c233c7d` | New `omni-mail-db`, created by the existing deploy script |
| R2 mail | `mailflare-raw` | `omni-mail-storage` |
| R2 backups | Unchanged | `omni-mail-backups` |
| Mail queue | `mailflare-inbound` / `mailflare-outbound` | `omnimail-mail` and its dead-letter queue |
| Notification queue | Unchanged | `omnimail-notifications` and its dead-letter queue |

The upstream backup and cleanup Workflows remain available for explicit actions.
Cron triggers are empty. Periodic external-mail sync, scheduled backups and
scheduled cleanup are not enabled.

The source has four setup-test messages, six attachments and no Drive files.
A private local snapshot contains all four messages and eight R2 objects,
verified against byte counts and SHA-256 hashes. The original D1, R2 and Worker
remain intact. The prepared default is a fresh OmniMail inbox with the old test
mail retained in the snapshot and original storage; no import has been performed.

## Activation after merge approval

1. Merge the reviewed branch. Authenticate with Cloudflare OAuth. For Wrangler,
   exclude API-key/token overrides from the child process and use its own OAuth
   session; never put account credentials in this repository.
2. Stage the merged source using a temporary Wrangler configuration in the
   repository root: use `omnimail.apehost.dev` for its route and `APP_ORIGINS`.
   Do not deploy the final `mail.apehost.dev` route before initialization.
   `npm run deploy -- --config <staging-config>` provisions separate resources
   and applies the checked-in D1 migrations. Do not bind Mailflare's database.
3. Set a randomly generated `SETUP_TOKEN` Secret, initialize the configured owner,
   and create the `apehost.dev` domain and `m0nkey@apehost.dev` receiving address.
   Reuse the existing mailbox password from the owner's private local credential
   file without printing or committing it. Remove `SETUP_TOKEN` after setup.
4. Verify login, private inbox/attachments and native sending on staging. Refresh
   the Mailflare snapshot and inspect any mail received since preparation.
5. Publish the final configuration, transferring `mail.apehost.dev` to `omni-mail`.
   Change only the `apehost.dev` catch-all rule to target `omni-mail` after the new
   mailbox is ready. The existing MX, SPF, DKIM and sending-domain onboarding stay
   in place. Verify delivery and attachments through the real routing path.
6. Remove the temporary staging hostname. Remove only the obsolete
   `mailflare_console_embedding` response-header rule if still present; OmniMail
   supplies its framing policy directly.

Zone: `e2c7c4a817c98ffccf4b3e964bd9aa13`. Existing catch-all rule:
`889466d315cc4933ac305ddfa144439d`, enabled, all recipients, Worker `mailflare`.
Existing mail custom domain: `548a11fa307a67cb93aed82811dfb5f55afbb613`.
The obsolete embedding rule is `283b02e91d1d45a29abf79f38922d729` in ruleset
`1ab9208593e04c3292795c102a3c0aae`.

Rollback returns the hostname and catch-all to `mailflare`. Keep both sets of
storage: mail received by OmniMail after cutover must remain available and be
reconciled before any later retirement. Nothing in this change deletes resources.

The console change is a separate PR against the explicitly approved
`feat/initial-shell` base, synchronized with `main` to preserve the current
floating-dock implementation and its session behavior. Check the shared deployed
revision again before activation so concurrent releases remain present.

## Validation

- `npm test`: 829 passing tests, including native sending, binary attachments,
  provider precedence, ambiguous failures and failure to record an accepted send.
- `npm run test:worker`: 67 passing tests in the real Worker runtime.
- `npm run build`: line limits, lint, three TypeScript checks and production build.
- All checked-in D1 migrations apply to a new local database.
- `node scripts/smoke-apehost.mjs`: a local Worker and Chromium verify trusted and
  untrusted framing, private inbox access, real browser sign-in and CSRF rejection.
  The production mail hostname is intercepted and forwarded to loopback; no live
  mailbox or real outbound transport is used.

To repeat the browser smoke, use local `.dev.vars` with `COOKIE_SECURE=false`,
`APP_ORIGINS=http://127.0.0.1:8942` and
`SETUP_TOKEN=local-smoke-only-setup-token-at-least-32-bytes`. Apply local migrations
and run `wrangler dev --local --ip 127.0.0.1 --port 8942`. The script creates a
local test owner on a fresh database. Local test passwords are never deployed.

Hono is patched to 4.13.13; the production dependency audit is clean. Upstream
development-tool dependency advisories remain. Public sign-in and real mail
delivery must be checked during activation; they are not claimed as verified here.
