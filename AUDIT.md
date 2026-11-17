# FinchPay requirement and evidence audit

The original local implementation and retained evidence are mapped below. Hosting is an additional adapter documented in the next section. Cross-chat refund deduplication and conversational recovery are extensions added after review; they are separate from the assignment's core role, verification, session, and UI requirements. The engineering note remains a candidate-review draft.

## Hosting extension (2026-11-17)

The Vercel adapter keeps the assignment's local server and mock store intact. `api/index.ts` and `src/hosted.ts` use `src/supabase.ts` and the prefixed migration. The same bounded loop now awaits either synchronous local tools or asynchronous persistent tools. New visitor workspaces use an opaque secure cookie; ownership is checked for every session operation.

The database enforces durable verification, failed-code state, expiring turn leases, stale-request rejection, and a unique workspace/charge refund record. Functions are service-role-only; tables deny browser roles. Checkpointed conversation state and ledger mutations are separate: retries deduplicate a committed refund, while a crash can leave an incomplete trace. No provider payment is executed.

The migration was applied to the existing connected project without changing Atlas tables. All 45 automated tests pass (the original 36 plus nine hosted cases). `tests/hosted-database.sql` passed against the real database, including null/expired/stale leases and failed-code crash recovery; test rows were rolled back. Evidence is in `evidence/hosted-test-results.txt` and `evidence/hosted-database-results.txt`. See [DEPLOYMENT.md](DEPLOYMENT.md) for settings and the remaining hosted limitations. A live Vercel/browser deployment has not been verified by these tests.

## Assignment requirements

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Triage → Identity → Refund with shared session | Role actions and awaited dispatcher in `src/agents.ts`, `src/loop.ts`, `src/session.ts` | Success trace; domain flow tests |
| Mock CH-101 / USD 25 and code 2468 | `src/tools.ts` | Success record; tool tests |
| Identity prompts; only successful verification authorizes refund | Input format gate, successful-result handoff, private session proof at tool boundary | Success and failed-claim/code traces; forged flag, handoff, and cross-session tests |
| Guard before refund side effect | Proof and charge checks precede ledger lookup/write | Direct-call rejection tests; source ordering review |
| Inspectable loop, handoffs, tools, wait/finish, bounded execution | Ordered trace; immediate return on wait/finish; 12 actions per resumed turn | Exported traces; loop-bound and terminal no-op tests |
| Local chat, Send, transcript, New chat | `web/` and fixed server assets | Desktop screenshots; HTTP and client tests |
| New chat gives a fresh unverified session | New server session; generation checks ignore stale client responses | Session isolation and delayed-response tests |
| Required success and failed verification conversations | Root trace exports for actual page-created sessions | `refund-success.json`, `verification-failure.json`; trace validation report |
| Reproducible local setup and engineering note | README, lockfile, scripts, one-page note | Fresh install/check/test; note covers execution, choice, alternative, limitation, AI use |

## Extensions and review findings

| Behavior | Implementation | Evidence |
| --- | --- | --- |
| Short command and charge aliases work reliably | Normalize spellings; exact supported command routes before model call | Alias and route tests; recovery trace |
| Repeated refund text does not count as a code attempt | Identity calls verifier only for four digits | Recovery trace calls verifier once with 2468; non-code regression cases |
| Clarification stays in the same chat | Recent normalized context; wait actions; Responses wording with fallback | Generated question/yes trace; context and adapter tests |
| New chat cannot duplicate this mock charge's refund within the process | Shared charge ledger; fresh verification before returning existing reference | Recovery reuses RF-001 with created=false; concurrent two-chat HTTP test |
| Existing refund result does not disclose another session handle | Tool result selects payment fields only | Cross-chat result test |
| API input and concurrency remain guarded | Strict message body; per-session lock across awaited turns | Invalid-field, size, overlap/409, and independent-session tests |
| API credential stays server-side | CLI environment loading; static allowlist; publication allowlist and byte scan | /.env returns 404; fake-key tests; credential and package verification reports |

## Verification records

- `evidence/typecheck-results.txt`: current TypeScript check.
- `evidence/test-results.txt`: 36 passing tests: 12 domain, seven HTTP, six Decisions, eight conversation/Responses, three client. Malformed-output cases include null values and invalid nested shapes.
- `evidence/clean-install-results.txt`: fresh-directory install from the npm cache, followed by check and tests; no `.env`, dependencies, or generated output copied in.
- `evidence/decisions-evaluation.json`: retained live evaluation, 14/14 scenarios, 13 Decisions calls, six generated replies. Not rerun during mechanical cleanup; prompt bytes and request contracts are preserved.
- `evidence/trace-validation.txt`: five browser traces checked for exact inputs, ordered events, verification before refund, and original reference reuse without another record.
- `evidence/limitation-check.txt`: fresh sessions share payment history; a newly constructed store permits the mock charge again, demonstrating the restart limit.
- `evidence/credential-scan.json`: selected files and decompressed archive checked against the configured credential without logging it.
- `output/package-verification.json`: final archive integrity, workspace-byte match, file count, hash, and credential exclusion. This generated report stays local alongside the ZIP.

## Retained browser evidence

| Trace | Result |
| --- | --- |
| `refund-success.json` | 28 events; verified; issued RF-001; one created record |
| `verification-failure.json` | 21 events; wrong code; unverified; no refund |
| `conversation-recovery.json` | 34 events; exact short command; repeated request re-prompts; verified existing RF-001; no additional record |
| `refund-question.json` | 21 events; generated answer and yes follow-up; waiting at Identity, unverified |
| `no-refund-requested.json` | Nine events; no handoff or refund |

These were captured in one server process, with New chat between journeys. See `traces/README.md` for provenance. Original trace payloads are unchanged. Five retained screenshots cover overview, success, failure, recovery, and conversational follow-up. Superseded reports, intermediate screenshots, old traces, and pre-cleanup source are preserved under ignored `.local/history/` and excluded from publication.

## Cleanup scope

Source, tests, HTML, and CSS are formatted for review. Triage context and charge selection have small named helpers. Prompts are readable constants/builders with their exact previous text. Responses JSON is handled as unknown and validated before use; invalid shapes use the existing fallback. Builds clear stale generated files. Packaging lists every submission file explicitly and rejects missing inputs.

Source review confirms that successful Identity verification still controls the verified-state assignment, the refund-map write follows proof and charge validation, the charge check/write has no await, and the server lock spans the awaited turn. Model wording has no tool or state-update channel.

## Remaining limits and review

Restart clears the ledger. Real payments require durable eligibility and provider idempotency. Identity uses a shared fake code with no account ownership, expiry, or account-level throttling; new chats reset the failed-code allowance. Fake codes remain visible in traces. Recent Triage text goes to OpenAI, and generated wording can be wrong despite shape/display checks. The small live evaluation is not calibrated accuracy or comprehensive prompt-injection coverage.

New chat does not cancel server work, revoke handles, or undo refunds. Export filename races have regression coverage; export-error display is not generation-checked. Actual endpoint exports were saved, but browser filesystem download delivery remains unverified. Desktop evidence does not establish a full accessibility/device audit. Candidate personal review, deployment, and external submission have not occurred.
