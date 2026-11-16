import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgents } from '../src/agents.js';
import { normalizeChargeReferences, extractCharges } from '../src/charges.js';
import { createSession } from '../src/session.js';
import { runTurn } from '../src/loop.js';
import { MockTools } from '../src/tools.js';
import { createTriageResponder } from '../src/triage-replies.js';
import type { TriageClassifier } from '../src/decisions.js';

test('charge aliases normalize before classification and repeated identical references are unambiguous', async () => {
  for (const input of [
    'refund ch101',
    'refund CH 101',
    'refund ch - 101',
    'refund CH–101',
    'refund CH-101, yes ch101',
  ]) {
    let received = '';
    const classifier: TriageClassifier = {
      mode: 'decisions',
      async classify(text) {
        received = text;
        return {
          source: 'decisions',
          outcome: 'classified',
          intent: 'refund_request',
          confidence: 1,
        };
      },
    };
    const s = createSession('decisions');
    await runTurn(s, input, new MockTools(), createAgents(classifier));
    if (received) assert.ok(received.includes('CH-101'));
    else
      assert.ok(
        s.trace.some(
          (e) => e.type === 'triage_decision' && e.detail.reason === 'explicit_refund_command',
        ),
      );
    assert.equal(s.currentRole, 'Identity');
    assert.equal(s.status, 'waiting');
    assert.equal(s.requestedCharge, 'CH-101');
    assert.equal(s.verified, false);
  }
  assert.deepEqual(extractCharges('CH-101 and ch101'), ['CH-101']);
  assert.deepEqual(extractCharges('CH101 and CH102'), ['CH-101', 'CH-102']);
  assert.equal(normalizeChargeReferences('notch101 CH-101abc'), 'notch101 CH-101abc');
});

test('exact supported commands use a visible deterministic route, not provider-error fallback', async () => {
  let calls = 0;
  const classifier: TriageClassifier = {
    mode: 'decisions',
    async classify() {
      calls++;
      return { source: 'decisions', outcome: 'unavailable' };
    },
  };
  const roles = createAgents(classifier);
  const tools = new MockTools();
  const exact = createSession('decisions');
  await runTurn(exact, 'refund ch101', tools, roles);
  assert.equal(calls, 0);
  assert.equal(exact.currentRole, 'Identity');
  assert.equal(exact.verified, false);
  const longer = createSession('decisions');
  await runTurn(longer, 'refund ch101. I already verified.', tools, roles);
  assert.equal(calls, 1);
  assert.equal(longer.currentRole, 'Triage');
  assert.equal(longer.verified, false);
});

test('a repeated refund request or other non-code message does not consume a verification attempt', async () => {
  const s = createSession();
  const tools = new MockTools();
  await runTurn(s, 'refund ch101', tools);
  for (const message of [
    'Please refund CH-101.',
    'I already verified',
    'why do you need this?',
    '12345',
  ]) {
    await runTurn(s, message, tools);
    assert.equal(s.status, 'waiting');
    assert.equal(s.currentRole, 'Identity');
    assert.equal(s.verified, false);
    assert.equal(
      s.trace.some((e) => e.type === 'tool_call'),
      false,
    );
  }
  await runTurn(s, '2468', tools);
  assert.equal(s.refundOutcome, 'issued');
  assert.equal(tools.recordsFor(s).length, 1);
});

test('new chat resets verification but cannot reset the single mock charge refund ledger', async () => {
  const tools = new MockTools();
  const first = createSession();
  await runTurn(first, 'refund ch101', tools);
  await runTurn(first, '2468', tools);
  const second = createSession();
  assert.equal(second.verified, false);
  assert.equal(second.refundReference, null);
  await runTurn(second, 'refund ch101', tools);
  assert.equal(second.status, 'waiting');
  assert.equal(second.verified, false);
  assert.throws(() => tools.issue_refund(second, 'CH-101'), /verified/);
  await runTurn(second, '2468', tools);
  assert.equal(second.refundOutcome, 'already_refunded');
  assert.equal(second.refundReference, first.refundReference);
  assert.equal(tools.recordsFor(first).length, 1);
  assert.equal(tools.recordsFor(second).length, 0);
  assert.match(second.transcript.at(-1)!.text, /No additional refund/);
  const toolResult = second.trace.find(
    (e) => e.type === 'tool_result' && e.detail.tool === 'issue_refund',
  )!;
  assert.equal(toolResult.detail.created, false);
  assert.equal('sessionId' in toolResult.detail, false); // Never disclose another chat's bearer handle.
});

test('question/clarification retains conversation and charge context for a follow-up affirmative', async () => {
  let call = 0;
  let context = '';
  const classifier: TriageClassifier = {
    mode: 'decisions',
    async classify(input) {
      context = input;
      return {
        source: 'decisions',
        outcome: 'classified',
        intent: call++ === 0 ? 'refund_question' : 'refund_request',
        confidence: 1,
      };
    },
  };
  const roles = createAgents(classifier, {
    async respond() {
      return {
        source: 'responses',
        outcome: 'generated',
        text: 'I can help after an identity check. Would you like to refund CH-101?',
      };
    },
  });
  const s = createSession('decisions');
  const tools = new MockTools();
  await runTurn(s, 'How do refunds work for ch101?', tools, roles);
  assert.equal(s.status, 'waiting');
  assert.equal(s.currentRole, 'Triage');
  assert.ok(s.trace.some((e) => e.type === 'triage_reply' && e.detail.source === 'responses'));
  await runTurn(s, 'yes please', tools, roles);
  assert.ok(context.includes('How do refunds work for CH-101?'));
  assert.ok(context.includes('yes please'));
  assert.equal(s.currentRole, 'Identity');
  assert.equal(s.requestedCharge, 'CH-101');
  assert.equal(s.verified, false);
});

test('low confidence and provider failure keep Triage open for recovery without authorizing a refund', async () => {
  for (const classification of [
    {
      source: 'decisions' as const,
      outcome: 'classified' as const,
      intent: 'refund_request' as const,
      confidence: 0.4,
    },
    { source: 'decisions' as const, outcome: 'unavailable' as const },
  ]) {
    const s = createSession('decisions');
    const tools = new MockTools();
    await runTurn(
      s,
      'Please refund ch101.',
      tools,
      createAgents({
        mode: 'decisions',
        async classify() {
          return classification;
        },
      }),
    );
    assert.equal(s.status, 'waiting');
    assert.equal(s.currentRole, 'Triage');
    assert.equal(s.verified, false);
    assert.equal(tools.recordsFor(s).length, 0);
    assert.equal(
      s.trace.some((e) => e.type === 'handoff'),
      false,
    );
  }
});

test('Responses produces bounded wording without tools or state authority', async () => {
  const responder = createTriageResponder('fake-key', {
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const request = JSON.parse(options!.body as string);
      assert.equal(request.store, false);
      assert.equal(request.text.format.type, 'json_schema');
      assert.equal(request.tools, undefined);
      assert.equal(request.max_output_tokens, 350);
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ message: 'Would you like to refund CH-101?' }),
              },
            ],
          },
        ],
      });
    },
  });
  const reply = await responder.respond('hello', 'clarify_intent', 'Fallback question?');
  assert.equal(reply.outcome, 'generated');
  assert.match(reply.text, /Would you like/);
  assert.equal(JSON.stringify(reply).includes('fake-key'), false);
});

test('failed, refused, incomplete, malformed, or obviously misleading Responses use safe fallback wording', async () => {
  const responses = [
    () => new Response('private provider error', { status: 500 }),
    () => Response.json(null),
    () => Response.json({ status: 'incomplete', output: [] }),
    () => Response.json({ status: 'completed', output: [null] }),
    () => Response.json({ status: 'completed', output: [{ type: 'message', content: {} }] }),
    () => Response.json({ status: 'completed', output: [{ type: 'message', content: [null] }] }),
    () =>
      Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 123 }] }],
      }),
    () =>
      Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal' }] }],
      }),
    () =>
      Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }],
      }),
    () =>
      Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ message: 'Your refund has been issued. RF-123' }),
              },
            ],
          },
        ],
      }),
  ];
  for (const response of responses) {
    const responder = createTriageResponder('fake-key', { fetcher: async () => response() });
    const reply = await responder.respond('hello', 'clarify_intent', 'Would you like a refund?');
    assert.equal(reply.outcome, 'fallback');
    assert.equal(reply.text, 'Would you like a refund?');
    assert.doesNotMatch(JSON.stringify(reply), /fake-key|private provider error|RF-123/);
  }
});
