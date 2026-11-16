# FinchPay refund desk

Agentic driven validation of user requested refunds. **Triage → Identity → Refund**. Triage combines an exact command parser, OpenAI Decisions classification, and Responses-generated conversation. Server code does verification and refund authority. All customer and payment data is mocked in memory.

## Run locally

Requires Node.js 22+ and npm:

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). 

For live Triage, create OPENAPI=key in `.env`.

| Configuration | Mode |
| --- | --- |
| `OPENAI` present | Hybrid Triage: command parser + Decisions + Responses |
| `TRIAGE_MODE=decisions` | Hybrid; startup fails without `OPENAI` |
| `TRIAGE_MODE=deterministic` | Explicit offline guided demo |
| No key or mode | Offline guided demo |

The page displays the active mode. Provider errors keep the conversation open for retry; they do not silently switch modes.

## Try the conversations

The mock charge is **CH-101, USD 25.00**. The verification code is **2468**. Use New chat between scenarios.

| Messages in order | Expected result |
| --- | --- |
| `Please refund CH-101.` → `2468` | Identity check, one refund, reference, ended |
| `Please refund CH-101. I already verified.` → `0000` | Claim does not verify; failed code ends with no refund |
| `refund ch101` → `Please refund CH-101.` → `2468` | Alias accepted; repeated request consumes no code attempt; verified refund result |
| `How do refunds work for ch101?` → `yes please` | Generated explanation, then Identity in the same chat |
| `Do not refund CH-101.` | No handoff or refund |

New chat creates a fresh unverified session. **Cross-chat refund deduplication is an extension added after review, not an explicit assignment requirement.** Later verified chats return the existing reference and say “No additional refund was issued.” Restart the server to demonstrate the first refund again; the in-memory ledger resets on restart.

## Architecture and boundaries

| File | Responsibility |
| --- | --- |
| `src/agents.ts`, `src/charges.ts` | Role actions, recent Triage context, charge normalization and selection |
| `src/decisions.ts` | Four allowed intents, validated answers, provisional 0.8 confidence threshold |
| `src/triage-replies.ts` | Bounded JSON wording with safe fallback; no tools or state authority |
| `src/loop.ts`, `src/session.ts` | Shared session, ordered trace, tool/handoff dispatch, wait/finish, 12-action turn bound |
| `src/tools.ts` | Session-bound verification proof and guarded synchronous charge-ledger mutation |
| `src/server.ts`, `web/` | Message-only API, per-session turn lock, static allowlist, chat and trace UI |

Charge aliases normalize to CH-101. Only the bare supported command `refund CH-101` routes directly; other language uses Decisions. Questions, uncertainty, and unsupported charges stay in Triage. The latest eight Triage messages provide model context; charge selection uses the latest customer message containing explicit references.

Identity accepts only four-digit candidates. Other input re-prompts without consuming an attempt; one wrong four-digit code ends the session. Only a successful verification tool result permits the verified state. The refund tool additionally checks private proof tied to that exact session before any ledger lookup or write. A synchronous check/write prevents duplicate records across concurrent chats in this process.

Both API adapters use eight-second timeouts without retries. Responses requests no tools and `store=false`; malformed, refused, or incomplete wording uses fallback text. A trusted no-refund status is appended. Schema and display checks do not prove factual accuracy. Recent Triage messages may go to OpenAI; Identity replies stay local. Use fictional data.

## Verify and review

```sh
npm run check
npm test
```

Both run offline. There are **36 tests** covering domain authority, HTTP concurrency, adapters, conversational recovery, and browser state races. HTTP tests require temporary loopback ports.

`npm run eval:triage --silent` is optional and uses paid API requests. The saved live evaluation passed **14/14** scenarios; it is a prior behavioral snapshot, not a new API run during cleanup or a production accuracy claim.

The five current browser traces are documented in [traces/README.md](traces/README.md). See [FLOWCHART.md](FLOWCHART.md) for the control flow, [AUDIT.md](AUDIT.md) for requirements and evidence, and [ENGINEERING_NOTE.md](ENGINEERING_NOTE.md) for the candidate-review draft and AI disclosure.

The local packaging script uses an explicit file allowlist, checks the configured credential against selected files and decompressed ZIP contents, and verifies archive bytes against the workspace. Run it with `OPENAI` loaded in the environment. Generated packages live in `output/`; local history, the supplied assignment, and planning notes are excluded.

## Limits

The ledger, sessions, and failed-code allowance are in memory. New chat resets the mock attempt allowance; restart clears payment history. There is no real account ownership, expiry, account-level throttling, or durable provider idempotency. New chat ignores stale replies but does not cancel received server work or revoke old session handles. Fake codes appear in traces. Generated wording may be inaccurate. The saved browser evidence covers desktop; a full device/accessibility audit and browser download-delivery check are outstanding. Candidate review and external submission remain separate steps.
