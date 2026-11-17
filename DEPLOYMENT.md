# Vercel and Supabase deployment

The local assignment demo still runs with `npm ci` and `npm run dev`, using memory only. Hosting is a separate adapter: Vercel serves three static browser assets and one Node.js API function; Supabase stores sessions, successful verification proof, failed-code state, request leases, and mock refund history. No real money moves.

## Project setup

The migration in `supabase/migrations/20261117224813_finchpay_hosted.sql` has been applied to the existing project at `https://pltgvinscoavmcaakdiw.supabase.co`. It creates only `finchpay_` tables/functions. Existing Atlas tables were preserved. For another project, apply that migration before deploying the app. Migrations must run once per database, not on every Vercel build.

The backend uses Supabase's REST RPC interface with native fetch; no database SDK, connection pool, Supabase Auth, or Edge Function is required for this mock demo. Tables have RLS enabled with no public policies, table grants are revoked from browser roles, and function execution is limited to `service_role`. The absence of browser policies is intentional: all access goes through the API's ownership checks.

## Vercel settings

Import the GitHub repository, set the project root to the repository root, and use the Other framework preset. `vercel.json` records:

| Setting | Value |
| --- | --- |
| Install | `npm ci` |
| Build | `npm run build:vercel` |
| Static output | `public` |
| Function entry | `api/index.ts` |
| Function duration | 60 seconds |

Remove conflicting dashboard build/output overrides if the project was previously configured for a different framework. The public build contains only HTML, CSS, and compiled browser JavaScript; do not use the repository root or all of `dist` as the static directory.

Add these variables to the Vercel environments being deployed:

| Name | Value |
| --- | --- |
| `OPENAI` | Existing OpenAI API credential |
| `TRIAGE_MODE` | `decisions` |
| `SUPABASE_URL` | `https://pltgvinscoavmcaakdiw.supabase.co` |
| `SUPABASE_SECRET_KEY` | The project's server secret key; legacy service-role keys also work |
| `APP_ORIGIN` | Exact HTTPS origin, such as `https://your-project.vercel.app`, without a path |

Secrets stay in Vercel's environment settings and never enter browser code. Modern Supabase secret keys use the `apikey` header; legacy JWT keys additionally use `Authorization: Bearer`. The API also accepts the exact `VERCEL_URL` deployment origin for previews. Cross-site browser requests are rejected. Preview and production should use separate Supabase projects or database branches when testing migrations against real data; this project is currently a disposable demo.

Push the commit to the connected GitHub branch to trigger Vercel, or redeploy that commit from Vercel. Environment changes take effect on a new deployment. This implementation commit does not itself push or publish a deployment.

## Hosted state and concurrency

A secure HttpOnly cookie identifies a demo workspace for 30 days. Only its SHA-256 hash is stored. New chat creates a fresh unverified session in the same workspace; different browsers/workspaces get independent mock CH-101 eligibility. Clearing that cookie starts a new demo workspace. This is demo isolation, not real customer authentication.

Each customer turn claims a 90-second database lease. Other instances receive 409 while the lease is active. Saving the session releases it; errors attempt release, and a crashed function's lease expires. Every tool/save operation checks the current lease, and an old request cannot release a replacement lease. The function's 60-second limit is shorter than the lease. Each database request and model call has an eight-second timeout without retries.

Successful verification creates durable proof before the refund RPC can run. Local tool proof and the session flag are also required. The database checks proof and the selected supported charge before looking up or creating a refund. A unique `(workspace_hash, charge_id)` constraint and atomic insert-or-return prevent duplicate records across instances and chats. References are `RF-<database id>` and need not be consecutive.

Refund creation commits separately from the final conversation snapshot. If a response is lost after a refund commits, repeating the verified request returns the existing reference; it cannot create a second refund. A crash can leave an incomplete trace, so the refund ledger is authoritative. A wrong code remains terminal even if the final snapshot was not saved. This is a mocked ledger, not payment-provider idempotency.

## Verification

```sh
npm run check
npm test
npm run build:vercel
```

The 45 automated tests include nine hosted tests using a shared remote-store substitute. They exercise fresh function instances, cookie/workspace isolation, duplicate prevention, malformed input, request overlap, adapter errors, and forged verification. Existing local tests remain offline. A fresh dependency installation also passed checks, tests, and the Vercel build; its output is in `evidence/hosted-clean-install-results.txt`.

`tests/hosted-database.sql` separately checks the actual migrated database as `service_role`: denied public access, ownership, verification, leases, duplicates, and failed-code crash recovery. Test rows are rolled back; identity sequences can advance. See `evidence/hosted-database-results.txt` for the recorded result. These database checks passed on the connected project. They do not establish a live Vercel deployment test or production load coverage.

After deployment, verify the normal success, failed-code, question/yes, repeated-request, New chat duplicate, and second-browser success journeys. Export a trace and confirm no secret is served in static assets. The existing screenshots and five original traces were captured from the local version; capture fresh hosted evidence before claiming hosted browser verification.

Hosted data currently has no automatic retention cleanup, user accounts, account-level throttling, or real verification. The local in-memory restart limitation still applies only to `npm run dev`; the hosted ledger survives restarts and redeployments.

References: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json), [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys), [database functions](https://supabase.com/docs/guides/database/functions).
