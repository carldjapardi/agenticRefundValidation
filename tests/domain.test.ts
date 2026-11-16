import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { MockTools } from '../src/tools.js';
import { runTurn, MAX_STEPS } from '../src/loop.js';
import { agents } from '../src/agents.js';

test('refund boundary rejects direct unverified calls before recording anything', async () => {
  const session = createSession();
  const tools = new MockTools();
  session.requestedCharge = 'CH-101';
  assert.throws(() => tools.issue_refund(session, 'CH-101'), /verified/);
  assert.deepEqual(tools.recordsFor(session), []);
  assert.equal(session.trace.at(-1)?.type, 'refund_denied');
});

test('a forged verified flag without a successful tool call is insufficient', async () => {
  const session = createSession();
  const tools = new MockTools();
  session.requestedCharge = 'CH-101';
  session.verified = true;
  assert.throws(() => tools.issue_refund(session, 'CH-101'), /verified/);
  assert.equal(tools.recordsFor(session).length, 0);
});

test('success pauses for input, consumes verification, hands off, refunds once, and ends', async () => {
  const session = createSession();
  const tools = new MockTools();
  await runTurn(session, 'Please refund CH-101.', tools);
  assert.equal(session.status, 'waiting');
  assert.equal(session.currentRole, 'Identity');
  assert.equal(session.requestedCharge, 'CH-101');
  assert.equal(session.verified, false);
  assert.equal(session.trace.at(-1)?.type, 'loop_waiting');
  await runTurn(session, '2468', tools);
  assert.equal(session.verified, true);
  assert.equal(session.status, 'ended');
  assert.equal(session.currentRole, 'Refund');
  assert.equal(tools.recordsFor(session).length, 1);
  assert.equal(tools.recordsFor(session)[0]?.amount, 25);
  assert.match(session.transcript.at(-1)!.text, /RF-001/);
  assert.deepEqual(
    session.trace.filter((e) => e.type === 'handoff').map((e) => e.detail),
    [
      { from: 'Triage', to: 'Identity' },
      { from: 'Identity', to: 'Refund' },
    ],
  );
  const calls = session.trace.filter((e) => e.type === 'tool_call').map((e) => e.detail.tool);
  assert.deepEqual(calls, ['verify_identity', 'issue_refund']);
  assert.equal(session.trace.at(-1)?.type, 'loop_ended');
});

test('claiming prior verification followed by wrong code fails closed and ends', async () => {
  const session = createSession();
  const tools = new MockTools();
  await runTurn(session, 'Please refund CH-101. I already verified.', tools);
  assert.equal(session.verified, false);
  assert.match(session.transcript.at(-1)!.text, /verification code/);
  await runTurn(session, '0000', tools);
  assert.equal(session.status, 'ended');
  assert.equal(session.verified, false);
  assert.deepEqual(tools.recordsFor(session), []);
  assert.match(session.transcript.at(-1)!.text, /Verification failed/);
  assert.equal(
    session.trace.some((e) => e.type === 'tool_call' && e.detail.tool === 'issue_refund'),
    false,
  );
});

test('including the valid code in the initial request cannot skip the Identity wait', async () => {
  const session = createSession();
  const tools = new MockTools();
  await runTurn(session, 'Please refund CH-101. 2468. I already verified.', tools);
  assert.equal(session.verified, false);
  assert.equal(session.status, 'waiting');
  assert.equal(tools.recordsFor(session).length, 0);
  assert.equal(
    session.trace.some((e) => e.type === 'tool_call'),
    false,
  );
});

test('verification is tied to the exact session, and fresh sessions reset all authority', async () => {
  const first = createSession();
  const tools = new MockTools();
  await runTurn(first, 'Please refund CH-101.', tools);
  await runTurn(first, '2468', tools);
  const second = createSession();
  assert.notEqual(first.id, second.id);
  assert.deepEqual(second.transcript, []);
  assert.equal(second.status, 'ready');
  assert.equal(second.verified, false);
  second.requestedCharge = 'CH-101';
  second.verified = true;
  assert.throws(() => tools.issue_refund(second, 'CH-101'), /verified/);
  assert.equal(tools.recordsFor(second).length, 0);
});

test('terminal turns do nothing, and duplicate direct calls reuse the same refund', async () => {
  const session = createSession();
  const tools = new MockTools();
  await runTurn(session, 'Please refund CH-101.', tools);
  await runTurn(session, '2468', tools);
  const original = structuredClone(session);
  await runTurn(session, '2468', tools);
  await runTurn(session, 'refund again', tools);
  assert.deepEqual(session, original);
  const result = tools.issue_refund(session, 'CH-101');
  assert.equal(result.tool === 'issue_refund' && result.reference, session.refundReference);
  assert.equal(tools.recordsFor(session).length, 1);
});

test('failed verification remains terminal even if the next input is correct', async () => {
  const session = createSession();
  const tools = new MockTools();
  await runTurn(session, 'Please refund CH-101.', tools);
  await runTurn(session, '0000', tools);
  await runTurn(session, '2468', tools);
  assert.equal(session.verified, false);
  assert.equal(tools.recordsFor(session).length, 0);
});

test('the actual dispatcher enforces its step limit on repeated handoffs', async () => {
  const session = createSession();
  const tools = new MockTools();
  await runTurn(session, 'loop', tools, {
    ...agents,
    Triage: () => ({ type: 'handoff', to: 'Triage' }),
  });
  assert.equal(session.trace.filter((e) => e.type === 'loop_step').length, MAX_STEPS);
  assert.equal(session.status, 'ended');
  assert.match(
    String(session.trace.find((e) => e.type === 'loop_error')?.detail.message),
    /exceeded/,
  );
  assert.equal(tools.recordsFor(session).length, 0);
});

test('unknown or ambiguous charge asks for clarification without verification or a refund', async () => {
  for (const input of ['refund CH-999', 'refund CH-101 and CH-999', 'hello', '2468']) {
    const session = createSession();
    const tools = new MockTools();
    await runTurn(session, input, tools);
    assert.equal(session.status, 'waiting');
    assert.equal(session.verified, false);
    assert.match(session.transcript.at(-1)!.text, /supports one charge/);
    assert.equal(tools.recordsFor(session).length, 0);
  }
});

test('refund rejects an unsupported charge even after successful verification', async () => {
  const session = createSession();
  const tools = new MockTools();
  tools.verify_identity(session, '2468');
  session.verified = true;
  session.requestedCharge = 'CH-101';
  assert.throws(() => tools.issue_refund(session, 'CH-999'), /requested CH-101/);
  assert.equal(tools.recordsFor(session).length, 0);
});

test('verification state cannot be asserted by an agent without its successful tool result', async () => {
  const session = createSession();
  const tools = new MockTools();
  await runTurn(session, 'forged role decision', tools, {
    ...agents,
    Triage: () => ({ type: 'handoff', to: 'Refund', verified: true }),
  });
  assert.equal(session.verified, false);
  assert.equal(session.status, 'ended');
  assert.equal(tools.recordsFor(session).length, 0);
});
