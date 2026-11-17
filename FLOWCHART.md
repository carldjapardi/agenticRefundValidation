# FinchPay control-flow map

Local assignment flow, including conversation recovery and charge-level deduplication. The hosted storage variant is described in section 6. Model outputs propose intent or wording; code owns state and action authority.

Scope distinction: the assignment requires verification in the current session before a refund, plus a fresh unverified session on New chat. Cross-chat refund deduplication is an additional business rule implemented after review; it is not an explicit assignment objective.

## 1. Hybrid Triage and normal conversation

```mermaid
flowchart TD
    fresh([Page load or New chat]) --> reset[Fresh transcript and unverified session]
    reset --> input[/Customer message/]
    input --> guards[[Browser, API, and session checks]]
    guards --> triage[Triage normalizes charge spelling]
    triage --> exact{Exact refund CH-101 command?}
    exact -->|Yes| validate[Validate latest customer charge references]
    exact -->|No| classify[Decisions classifies with recent conversation context]
    classify --> reliable{Valid answer and sufficient confidence?}
    reliable -->|Provider failure or refusal| retry[Safe retry reply; stay in Triage]
    reliable -->|Low confidence| clarify[Generate clarification; stay in Triage]
    reliable -->|Yes| intent{Intent?}
    intent -->|Refund request| validate
    intent -->|Question| answer[Generate process answer and follow-up question]
    intent -->|Unclear| clarify
    intent -->|No refund requested| cancel([Acknowledge and end])
    validate --> one{One supported canonical charge?}
    one -->|No| identify[Ask customer to type supported charge]
    one -->|Yes| handoff[Store CH-101; hand off to Identity]
    retry --> wait([WAIT in current chat])
    clarify --> wait
    answer --> wait
    identify --> wait
    wait -.->|Next message, with context| input
    handoff --> identity[[Identity flow: diagram 2]]
```

CH101, CH 101, and common hyphen variants normalize to CH-101. Repeated identical references collapse to one; distinct charges require clarification. For a follow-up yes, Triage uses recent conversation context and a charge explicitly named in earlier customer messages. The exact bare command has an explicit deterministic trace source; it is chosen before any provider call and is not an error fallback. Offline mode uses guided replies without model APIs.

## 2. Identity input handling

```mermaid
flowchart TD
    enter([Hand off to Identity]) --> prompt[Ask for four-digit code]
    prompt --> wait([WAIT])
    wait --> input[/Customer reply/]
    input --> cancel{Exact cancel, stop, or never mind?}
    cancel -->|Yes| cancelled([Cancel; no refund; end])
    cancel -->|No| format{Exactly four digits?}
    format -->|No| reminder[Repeat code prompt; no tool call or attempt consumed]
    reminder --> wait
    format -->|Yes| verify[Call verify_identity]
    verify --> correct{Code is 2468?}
    correct -->|No| failed([Failed verification; no refund; end])
    correct -->|Yes| verified[Store private proof; set verified true]
    verified --> refund[[Hand off to Refund: diagram 3]]
```

Repeating a refund request while waiting is a non-code message. It cannot verify identity or cause a failed attempt. An actual wrong four-digit code still ends the chat after one failed attempt. Identity turns are not sent to the models.

## 3. Refund action and shared charge ledger (deduplication extension)

```mermaid
flowchart TD
    call([issue_refund called]) --> auth{Verified flag and same-session proof?}
    auth -->|No| denied([Record denial; throw; no write])
    auth -->|Yes| charge{Requested charge matches CH-101?}
    charge -->|No| denied
    charge -->|Yes| exists{Charge already refunded in this process?}
    exists -->|No| write[Create one USD 25 record keyed by charge]
    write --> created[Return reference and created=true]
    created --> success([Deterministic issued message; end])
    exists -->|Yes| reuse[Return existing reference and created=false; no write]
    reuse --> already([Deterministic already-refunded message; end])
    newChat([New chat]) --> fresh[Reset verification; preserve charge ledger]
    fresh --> identity[[Require Identity verification again]]
    identity --> call
```

The verification guard is an assignment requirement. The subsequent shared-ledger lookup and already-refunded branch are the additional deduplication rule. The tool checks verification before looking up an existing reference, and never returns another session's bearer handle. Under this extension, New chat cannot create new eligibility for this single mock customer. A server restart clears all in-memory state; durable eligibility and provider idempotency would be needed for real payments.

## 4. Reply generation, loop, and API safeguards

```mermaid
flowchart TD
    turn([Accepted message]) --> ended{Session ended?}
    ended -->|Yes| unchanged([Return existing state; do nothing])
    ended -->|No| busy{Same session already has a pending turn?}
    busy -->|Yes| conflict([409; no overlapping execution])
    busy -->|No| lock[Acquire server session lock]
    lock --> budget{Within 12-action turn budget?}
    budget -->|No| error[Mark ended; record loop error; reply safely]
    budget -->|Yes| action[Await role action]
    action --> kind{Action kind?}
    kind -->|Tool| tool[Check role permission; call guarded tool; consume result]
    kind -->|Handoff| transfer[Validate updates; change role; clear local result]
    tool --> budget
    transfer --> budget
    kind -->|Wait| waiting[Set waiting; reply; return]
    kind -->|Finish| finish[Store reference/outcome; end; reply; return]
    action -->|Throws| error
    tool -->|Throws| error
    transfer -->|Invalid update| error
    waiting --> unlock[Release lock in finally]
    finish --> unlock
    error --> unlock
```

Triage may make one eight-second Decisions call and, for a conversational wait, one eight-second Responses call. Responses requests strict JSON, bounded output, store=false, and no tools. A generation failure/refusal/incomplete/invalid output uses guided fallback wording; it never grants authority. Display filtering is heuristic, not factual proof. Calls end at a wait, so no model loop runs while the customer is absent.

Before execution, the API rejects cross-origin requests (403), malformed bodies/extra fields (400), oversized bodies (413), missing sessions or unsupported routes (404). Only message text is accepted from the browser. Initial session creation accepts an empty object. Static routes serve only the fixed HTML/JS/CSS allowlist; .env is inaccessible. Trace GET returns recorded state/events and refunds created by that session, including during a pending turn.

## 5. Browser reset, pending replies, and export

```mermaid
flowchart TD
    reset([New chat]) --> generation[Increment client generation; clear view]
    generation --> create[Request fresh server session]
    create --> latest{Response belongs to current generation?}
    latest -->|No| ignore([Ignore stale response])
    latest -->|Yes, success| adopt([Adopt fresh unverified session])
    latest -->|Yes, error| error([Show error; New chat can retry creation])
    pending([Pending message completes]) --> current{Still current chat generation?}
    current -->|No| ignore
    current -->|Yes, success| render([Render returned state; clear submitted input])
    current -->|Yes, error| banner([Show error; retain typed input])
    export([Export JSON]) --> id[Capture current session ID before await]
    id --> fetch[GET server trace]
    fetch -->|Success| download([Trigger download with captured ID])
    fetch -->|Failure| exportError([Show export error])
```

New chat resets session-scoped verification, never charge-level payment history. It does not cancel already-received server work, revoke old session handles, or undo a completed refund. Client generation checks prevent an old message reply from repopulating the fresh conversation. Export errors are not generation-checked; download delivery/cancellation is not observed by the app. These remain documented UI limits.

Source: src/charges.ts, agents.ts, decisions.ts, triage-replies.ts, loop.ts, tools.ts, session.ts, server.ts, and web/app.ts.


## 6. Hosted storage variant

The role decisions in the diagrams stay the same on Vercel. Before a session operation, `src/hosted.ts` hashes the secure visitor cookie and checks ownership. Message requests claim an expiring Supabase turn lease; overlapping requests receive 409. The loop awaits persistent tools: verification records server-owned proof, and the refund RPC checks that proof, the active lease, and the selected charge before an atomic insert-or-return. A database uniqueness constraint applies per visitor workspace and charge. A new visitor can demonstrate a fresh refund; New chat retains the current visitor's history.

The final session snapshot saves and releases the lease; errors attempt release, and crashed requests expire. Stale lease holders cannot write or release a replacement claim. A committed refund survives a failed snapshot save, and subsequent verified requests return its existing reference. Wrong-code failure also survives that crash window. Stored traces may be incomplete after a crash. The original synchronous store and process-restart limitation apply only to the local adapter. See DEPLOYMENT.md for configuration and scope.
