# Actual browser evidence

Current root traces were captured from the real localhost chat page with HYBRID TRIAGE active. They are actual server export payloads for page interactions, not reconstructed examples or unit-test substitutes.

| Trace | Messages | Outcome |
| --- | --- | --- |
| refund-success.json | Please refund CH-101. / 2468 | 28 events; one new refund RF-001; issued |
| verification-failure.json | Please refund CH-101. I already verified. / 0000 | 21 events; no refund; ended |
| conversation-recovery.json | refund ch101 / Please refund CH-101. / 2468 | 34 events; exact-command route, repeated message consumes no attempt, existing RF-001 returned; no new refund |
| refund-question.json | How do refunds work for ch101? / yes please | 21 events; Responses-generated answer, contextual follow-up reaches Identity; waiting and unverified |
| no-refund-requested.json | Do not refund CH-101. | 9 events; no handoff or refund; ended |

All five were run in the same server process, separated by New chat. The recovery trace's created=false result points to the success trace's original RF-001, proving that a new chat did not reset charge eligibility. The verifier in the recovery trace is called once, with 2468; the repeated request did not reach it.

Each trace was saved by GET /api/sessions/<id>/trace using the exact session identifier shown in the page's expanded trace panel. That is the same endpoint used by Export JSON. Events/state were saved without rewriting. Screenshots are in ../evidence/. conversational-triage.png includes the generated answer, follow-up yes, and Identity prompt. conversation-recovery.png shows the repeated request and already-refunded result.

Historical traces are preserved locally under ignored .local/history/traces/ and excluded from the submission. Cross-chat deduplication is an extension added after review, not an explicit assignment requirement. The embedded browser's filesystem download delivery remains unverified; endpoint exports are the saved evidence.

Timestamps are UTC. Trace metadata identifies deterministic/Decisions intent and Responses/fallback wording separately. API credentials and provider error bodies are not recorded. Fake code inputs remain visible for this mocked exercise; do not log real verification secrets this way.
