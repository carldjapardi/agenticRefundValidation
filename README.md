# FinchPay refund desk

Agentic driven validation of user requested refunds. **Triage → Identity → Refund**. Triage combines an exact command parser, OpenAI Decisions classification, and Responses-generated conversation. Server code does verification and refund authority. All customer and payment data is mocked. The local assignment version uses memory; the hosted adapter uses Supabase.

## Engineering Decision 
See the engineering note md for more detail.

In essence, the Triage agent uses a hybrid of OpenAI Decisions and deterministic code. I decided to go with this hybrid plan because it can understand user intent better than a regex parser, and provides a flexible response to user questions. 

OpenAI Decisions returns a structured JSON classification (refund_request, refund_question, no_refund_requested, or unclear) with a confidence score for the selected intent.

Code validates the result and charge, then determines whether to ask for clarification, explain the process, hand off to Identity, or end the conversation. Low-confidence classifications trigger clarification. Exact supported refund commands are handled directly by code.

The OpenAI Responses API generates Triage explanations and clarification questions, with predetermined fallback messages if generation fails.

Identity prompts and refund confirmations remain deterministic. Verification and refund authorization are enforced in code; model output cannot authorize a refund.

## Run locally
```sh
npm ci
npm run dev
```
Open [localhost:3000](http://localhost:3000). 

For live Triage, set `OPENAI=your-key` in a private `.env` file. Node.js 22+ is required.

| Configuration | Mode |
| --- | --- |
| `OPENAI` present | Hybrid Triage: command parser + Decisions + Responses |
| `TRIAGE_MODE=decisions` | Hybrid; startup fails without `OPENAI` |
| `TRIAGE_MODE=deterministic` | Explicit offline guided demo |
| No key or mode | Offline guided demo |

The page displays the active mode. Provider errors keep the conversation open for retry; they do not silently switch modes.

## Host on Vercel + Supabase

The hosted adapter uses the same roles and UI, with durable session/verification/refund storage and database-backed turn locks. Each visitor has a separate mock payment history; New chat retains that visitor's history and requires fresh verification.

`vercel.json` configures `npm run build:vercel`, static output in `public`, and a shared API function. Set `OPENAI`, `TRIAGE_MODE=decisions`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `APP_ORIGIN` in Vercel. The migration has been applied to the connected Supabase project. See [DEPLOYMENT.md](DEPLOYMENT.md) for setup, concurrency, security boundaries, and remaining demo limits.

Run `npm run check`, `npm test` (45 tests), and `npm run build:vercel` before deployment. The five saved browser traces are local evidence; the hosted database has separate regression checks.

## Try the conversations

The mock charge is **CH-101, USD 25.00**. The verification code is **2468**. Use New chat between scenarios.

| Messages in order | Expected result |
| --- | --- |
| `Please refund CH-101.` → `2468` | Identity check, one refund, reference, ended |
| `Please refund CH-101. I already verified.` → `0000` | Claim does not verify; failed code ends with no refund |
| `refund ch101` → `Please refund CH-101.` → `2468` | Alias accepted; repeated request consumes no code attempt; verified refund result |
| `How do refunds work for ch101?` → `yes please` | Generated explanation, then Identity in the same chat |
| `Do not refund CH-101.` | No handoff or refund |

New chat creates a fresh unverified session. **Cross-chat refund deduplication is an extension added after review, not an explicit assignment requirement.** Later verified chats return the existing reference and say “No additional refund was issued.” Locally, restart the server to demonstrate the first refund again. Hosted refund history survives restarts; a different demo visitor gets independent eligibility.

## Architecture and boundaries

| File | Responsibility |
| --- | --- |
| `src/agents.ts`, `src/charges.ts` | Role actions, recent Triage context, charge normalization and selection |
| `src/decisions.ts` | Four allowed intents, validated answers, provisional 0.8 confidence threshold |
| `src/triage-replies.ts` | Bounded JSON wording with safe fallback; no tools or state authority |
| `src/loop.ts`, `src/session.ts` | Shared session, ordered trace, tool/handoff dispatch, wait/finish, 12-action turn bound |
| `src/tools.ts` | Session-bound verification proof and guarded synchronous charge-ledger mutation |
| `src/server.ts`, `web/` | Local API, per-session turn lock, static allowlist, chat and trace UI |
| `api/index.ts`, `src/hosted.ts`, `src/supabase.ts` | Hosted API, visitor ownership, persistent tools and turn leases |
| `supabase/migrations/` | Backend-only tables/RPCs and atomic refund deduplication |

Charge aliases normalize to CH-101. Only the bare supported command `refund CH-101` routes directly; other language uses Decisions. Questions, uncertainty, and unsupported charges stay in Triage. The latest eight Triage messages provide model context; charge selection uses the latest customer message containing explicit references.

Identity accepts only four-digit candidates. Other input re-prompts without consuming an attempt; one wrong four-digit code ends the session. Only a successful verification tool result permits the verified state. The refund tool additionally checks private proof tied to that exact session before any ledger lookup or write. Locally, a synchronous check/write prevents duplicate records in this process. Hosting adds durable verification checks and an atomic database uniqueness constraint.

Both API adapters use eight-second timeouts without retries. Responses requests no tools and `store=false`; malformed, refused, or incomplete wording uses fallback text. A trusted no-refund status is appended. Schema and display checks do not prove factual accuracy. Recent Triage messages may go to OpenAI; Identity replies stay out of OpenAI; the hosted adapter sends the fake code to its database verifier. Use fictional data.

## Limits

The local ledger and sessions are in memory; restart clears local payment history. Hosting persists them in Supabase. New chat resets the mock attempt allowance in both modes. There is no real account ownership, account-level throttling, or payment-provider idempotency. Hosting uses an expiring demo cookie for visitor isolation. New chat ignores stale replies but does not cancel received server work or revoke old session handles. Fake codes appear in traces. Generated wording may be inaccurate. The saved browser evidence covers desktop; a full device/accessibility audit and browser download-delivery check are outstanding. Candidate review and external submission remain separate steps.
