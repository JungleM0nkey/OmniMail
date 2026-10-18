# Independent Mailflare import verification

Run from a checkout containing the verifier after the destination is imported.
Node 22 or newer and the installed `postal-mime` dependency are required.
Keep both the snapshot and credentials outside Git in a private directory.

```powershell
rtk proxy node scripts/verify-mailflare-import.mjs `
  --base https://omnimail.apehost.dev `
  --snapshot D:/private/mailflare-snapshot.json `
  --account 7031244e5dbce80f897a55df4b7c859b `
  --database <destination-D1-UUID> `
  --bucket omni-mail-storage `
  --credentials C:/Users/ilya9/.mailflare/apehost.dev.json `
  --receipt D:/private/parity-new.json
```

`--base` is the explicit HTTPS origin receiving the owner login. Change it to
`https://mail.apehost.dev` for final verification after the domain cutover.
The credentials file contains `email` and `password`; its default path is the
path above. The script uses the existing Cloudflare OAuth helper and reads the
OAuth access token inside its process. No API token or API key is used.

The verifier reads the snapshot itself and independently computes destination
IDs and keys. It reads destination D1 rows, metadata archives, search data, R2
objects, and signed-in API responses. An importer receipt is never an input.
It checks all imported IDs, both directions, mailbox ownership, visible folders,
read/starred flags, original and MIME timestamps, headers, native thread groups,
body text/HTML, raw MIME, attachment bytes/metadata, quota accounting, body
search, anonymous denial, foreign-origin CSRF denial, and exact framing headers.

The only application mutations are owner login and cleanup of that session.
The CSRF probe attempts to log out its own session with a rejected origin; it
must return 403 and leave the session active. The script sends no email, changes
no message, polls no queue, and accepts no `--execute` option.

The private JSON receipt is created with exclusive creation and mode 0600;
choose an existing private directory on Windows so its inherited ACL is private.
An existing receipt is never replaced. The receipt contains counts, hashes,
revision/target identities, and safe check codes, with no passwords or bodies.
`targetState` records actual full imported D1 row hashes and the byte hashes of
every observed raw, attachment, and body object for the retirement gate to
independently recheck target drift. It excludes unrelated new live mail.

`parity.verified: true` and exit 0 mean every required migration parity check
passed. `FAILED` means a checked condition failed. `UNVERIFIED` records a check
that could not be reached; it never substitutes for a pass. Optional deployment
metadata uses `required: false` and does not establish application behavior.

This receipt certifies comparison with the supplied snapshot. It does not prove
that source mail stopped changing or authorize deleting Mailflare. The parent
cutover procedure must independently check current-source freshness, complete
backups, live sending/receiving, and the signed-in Console Browser Harness flow.
Those criteria remain explicitly `UNVERIFIED` in `remainingAcceptance`.

Run the focused fixtures with:

```powershell
rtk npm test -- scripts/verify-mailflare-import.test.ts
```
