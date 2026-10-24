# Google Workspace resource integrations

The native read slice uses the shared integration definitions, connections,
workspace bindings and attempt-scoped MCP gateway. Gmail, Drive, Docs, Sheets and
Calendar are groups in one Google Workspace collection. Multiple account connections
have independent labels, credential records, tool names and workspace grants.
Engine-independent HTTP adapters run cold in the existing control/API process.
The agent worker receives only descriptors and bounded tool results, never Google
tokens. There is no browser, background mailbox index, worker pool or cloud queue.
Eve remains an architectural reference, not a runtime dependency.

## Configure resource authorization

Owner sign-in requests identity scopes only. It grants **zero** Google data access.
Resource OAuth has its own configuration, state/PKCE/nonce, verified account ID,
encrypted refresh token and read-scope selection. Use a separate OAuth Web client;
a separate Google project also isolates provider revocation from owner sign-in and
other applications. No Google project or account was created by this implementation.

For a real deployment, enable only the selected Gmail/Drive/Docs/Sheets/Calendar APIs
in your own project and configure the Google OAuth consent screen/test audience.
Create a Web application client with the exact callback origin and path you serve:
`https://control.example.com/api/integrations/google/callback` (loopback HTTP is
accepted for local development). Redirect origins are never inferred from a model
argument. Configure these **control-process-only** variables:

```dotenv
HARNESS_GOOGLE_RESOURCE_CLIENT_ID=your-separate-web-client
HARNESS_GOOGLE_RESOURCE_CLIENT_SECRET=your-separate-client-secret
HARNESS_GOOGLE_RESOURCE_REDIRECT_URI=https://control.example.com/api/integrations/google/callback
HARNESS_GOOGLE_RESOURCE_KEY_ID=primary
HARNESS_GOOGLE_RESOURCE_KEY=32-random-bytes-encoded-as-base64url
```

Generate a dedicated encryption key using Node `randomBytes(32).toString("base64url")`
in your own secret-management workflow. The key is never derived from owner login,
a worker/tool grant or a connection label. Missing/invalid key configuration fails
closed. Back it up separately from the database and restrict access to both.

Open **Settings → Integrations → Google Workspace accounts**, name the account,
select read groups and choose Add Google account. Google performs account selection
and consent. Return to Settings, verify the actual account email/granted groups,
then explicitly select tools and enable access for each workspace. Connections grant
no workspace access automatically. Reconnect requires the same verified Google
subject; add a new connection for another account. Reconnect, scope changes and
disconnect change the common connection revision so workspace grants need review.

Resource authorization uses expiring owner-session/browser-bound single-use hashed
state, encrypted PKCE verifiers, nonce and signed Google ID-token verification
(issuer, audience, azp, subject, verified email, expiry). No token/code/provider error
body is returned to the model, logged or appended to a callback redirect. The
callback returns only `google=connected` or `google=failed` to Settings.

## Read scopes and limits

| Group | Requested data scope | Available tools |
| --- | --- | --- |
| Gmail | `https://www.googleapis.com/auth/gmail.readonly` | `gmail.search`, `gmail.read_thread` |
| Drive | `https://www.googleapis.com/auth/drive.readonly` | `drive.search`, `drive.get_file` |
| Docs | `https://www.googleapis.com/auth/documents.readonly` | `docs.read` |
| Sheets | `https://www.googleapis.com/auth/spreadsheets.readonly` | `sheets.metadata`, `sheets.read_range` |
| Calendar | `https://www.googleapis.com/auth/calendar.events.readonly` | `calendar.list_events` |

Resource OAuth also requests `openid email` solely to verify the separately selected
account. Scope grants come from the actual token response, not the requested groups.
The broker checks the exact tool group's scope on every admission; losing scopes
or `invalid_grant` blocks reads and prompts reconnection. Refresh token expiry, when
returned by Google, is recorded and enforced. Read scopes confer no draft/write/send
capability. Google scopes can cover more resources than a workspace permits.

Workspace limit controls accept explicit file IDs (Drive/Docs/Sheets), Gmail label
IDs, calendar IDs and finite Sheets A1 range grants. Empty controls remove that
harness restriction for the associated group. A file denylist is not supported;
an explicit allowlist is enforced before any file read. Label-constrained thread
reads reject threads containing messages outside the allowed labels. Sheet ranges
must name a tab and finite cells, such as `'Revenue 2026'!A1:D20`; reads must be
contained within a granted range. Folder grants are rejected instead of pretending
that path strings enforce shared-drive membership. Restrictions supplement Google
consent and the common workspace tool allowlist; they never widen either grant.

Search/list tools return one page of at most 50 items (default 20). Cursor signatures
bind provider continuation to account, connection revision, workspace, query,
representation and constraints, and expire after 15 minutes. Search pages may omit
results, including when file grants filter a Drive page. Continue with the returned
cursor rather than treating a page as a complete account download.

Gmail reads at most 20 messages with bounded selected headers and plain text; HTML,
attachments and attachment downloads are unavailable. Drive search treats query text
as an escaped literal name substring and includes accessible shared drives. Drive
get_file defaults to metadata; explicit text mode supports text MIME types and
Google Docs plain-text export. Other editor formats/binaries use dedicated tools
or report unsupported. Shortcuts are returned as metadata and never followed.
Docs reads nested tabs, tables, headers/footers and revision evidence; embedded
objects and suggestion resolution are explicitly omitted. Sheets reads preserve
formatted/raw/formula values and serial date representations, at most 200 rows,
50 columns and 5000 cells per explicit range. Calendar requires RFC3339 start/end,
a positive interval of at most 31 days and an IANA time zone. It expands recurring
events, omits cancelled events and preserves timed/all-day start/end values. Google
filters overlapping events by exclusive event-end `timeMin` and event-start `timeMax`.

HTTP responses are bounded at 1 MiB; reads have a 15-second request budget inside
the gateway's 25-second budget. Combined UTF-8 tool results are bounded below the
64 KiB gateway limit, with explicit truncation/partial markers and source account,
resource/tool identity, representation, link and retrieval time. Content is marked
untrusted external data. Quota and transport failures are sanitized and have no
blind automatic retries. Cancellation, turn stop or revision changes fence receipts
and abort active HTTP requests through the common gateway. Credentials are refreshed
and used only in the control process; known access token bytes are removed from
successful tool results as an additional guard.

## Credential lifecycle and recovery

Google refresh tokens and OAuth PKCE verifiers are AES-256-GCM ciphertext with a
separate purpose/account domain and named key version. No access token is persisted.
Metadata, credentials and OAuth states use separate additive SQLite/Postgres tables.
A 60-second per-account database lease serializes token refresh/rotation/disconnect
across control processes. HTTP work occurs outside transaction retry loops; a lost
refresh response is never replayed automatically. Reconnect handles credentials
that became unusable after a provider rotation/expired grant. Missing refresh tokens
on consent preserve a valid same-account token; a first connection without offline
access is rejected. Concurrent authorization changes fail with revision conflicts.

Disconnect immediately changes the common connection revision, erases this
connection's ciphertext and outstanding consent states, and fences its workspace
bindings. It does not delete remote mail/files or revoke another account. To revoke
provider authorization, use Google's third-party access settings. Google project
revocation can invalidate **all scopes and clients** under that project for the same
account, so disconnect intentionally avoids making a misleading per-connection
revocation request. Provider revocation is detected on the next refresh.

For key rotation, install a new current key/ID and retain old keys in
`HARNESS_GOOGLE_RESOURCE_PREVIOUS_KEYS` as a JSON map of key ID to base64url key.
Existing ciphertext remains decryptable. An owner-authenticated POST to
`/api/integrations/google/disconnect` with `action: "rotate_key"`, `connectionId`
and the current common `expectedRevision` re-encrypts that account with the current
key and invalidates its reviewed workspace grants. Refresh-token replacement and
reconnect also encrypt with the current key. Remove old keys only after all accounts
have been rotated/reconnected and recovery has been tested. Retain old keys for old
backups. Database export/import includes Google tables automatically; keys are a
separate restore input. Deleting a common connection cascades its Google records;
deleting one workspace removes its bindings and preserves other account grants.

## Fixture evidence and external gates

`pnpm check`, `pnpm test` (113 total: 106 passed, seven existing optional
external-service skips), `pnpm build` and `pnpm smoke:google` passed locally. The
Google smoke starts an isolated production stack on port 3212, intercepts Google
HTTP through a controlled local provider fixture, completes signed resource OAuth,
executes all eight tools through the actual attempt gateway, verifies encrypted
credentials/disconnect/token-free receipts and logs, then invokes the actual
`pnpm smoke` Workflow/worker suite. It stops owned processes and deletes fixture
data in a finally block. Run it with a free 3212 port; never point fixtures at 3000.

`pnpm test` includes signed OAuth/PKCE/JWKS and actual owner route-handler fixtures,
wrong owner/state replay/nonce/redirect, missing refresh token, multiple accounts,
concurrent leases, rotation/scope loss/revocation, Gmail MIME, Drive escaping/file
grants, Docs nested tabs, Sheets types/ranges/representations, Calendar occurrences,
quota/body bounds and shared gateway descriptor/dispatch/receipt/duplicate behavior.
Known Google control secrets are excluded from native process environments by the
existing allowlist, with regression coverage. Fixtures never contact a real account
or model. SQLite integration/deletion tests run locally; live PostgreSQL parity and
real-provider/deployment acceptance still require intentionally selected validation.

Google Gmail readonly is a restricted scope and Drive readonly may also impose
restricted-scope verification/security-assessment requirements. Public deployment,
consent audience/testing token lifetime, provider verification and organization API
access policies remain real Google project gates. No drafts, document/sheet edits,
email sending, push subscriptions, mailbox indexing, LinkedIn API integration or
remote executor are implemented by this slice.

Official sources checked on 2026-10-23:

- [Google OAuth web-server/offline/incremental authorization and revocation](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OpenID Connect account verification](https://developers.google.com/identity/openid-connect/openid-connect)
- [Gmail scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail thread reads](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get)
- [Drive list/shared-drive parameters](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
- [Drive file reads](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)
- [Docs tabs](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get)
- [Sheets representations](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)
- [Calendar event intervals/recurrence/scopes](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
