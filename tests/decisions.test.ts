import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDecisionsClassifier,
  classifierFromEnvironment,
  type Intent,
} from '../src/decisions.js';
import { createAgents } from '../src/agents.js';
import { createSession } from '../src/session.js';
import { MockTools } from '../src/tools.js';
import { runTurn } from '../src/loop.js';

function response(choice: unknown = 'refund_request', confidence: unknown = 1): Response {
  return Response.json(
    { answers: [{ type: 'choice', name: 'triage_intent', choice, confidence }] },
    { headers: { 'x-request-id': 'test-request-id' } },
  );
}

test('Decisions sends one bounded choice request and returns only allowlisted metadata', async () => {
  let calls = 0;
  const classifier = createDecisionsClassifier('fake-test-key', {
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/decisions');
      assert.equal(
        (options!.headers as Record<string, string>).Authorization,
        'Bearer fake-test-key',
      );
      const body = JSON.parse(options!.body as string);
      assert.equal(body.model, 'gpt-6-luna');
      assert.equal(body.input, 'Please refund CH-101.');
      assert.equal(body.questions.length, 1);
      assert.equal(body.questions[0].type, 'choice');
      assert.equal(body.questions[0].choices.length, 4);
      assert.ok(options!.signal);
      return response();
    },
  });
  const result = await classifier.classify('Please refund CH-101.');
  assert.equal(calls, 1);
  assert.equal(result.intent, 'refund_request');
  assert.equal(result.requestId, 'test-request-id');
  assert.equal(JSON.stringify(result).includes('fake-test-key'), false);
});

test('question, negation, unclear, and low confidence never hand off or refund', async () => {
  const cases: [Intent, number][] = [
    ['refund_question', 1],
    ['no_refund_requested', 1],
    ['unclear', 1],
    ['refund_request', 0.79],
  ];
  for (const [intent, confidence] of cases) {
    const classifier = createDecisionsClassifier('fake', {
      fetcher: async () => response(intent, confidence),
    });
    const s = createSession('decisions');
    const tools = new MockTools();
    await runTurn(s, 'Please refund CH-101.', tools, createAgents(classifier));
    assert.equal(s.status, intent === 'no_refund_requested' ? 'ended' : 'waiting');
    assert.equal(s.requestedCharge, null);
    assert.equal(s.verified, false);
    assert.deepEqual(tools.recordsFor(s), []);
    assert.equal(
      s.trace.some((e) => e.type === 'handoff'),
      false,
    );
    assert.ok(s.trace.some((e) => e.type === 'triage_decision'));
  }
});

test('live-mode classification still requires code-owned charge validation and identity verification', async () => {
  const classifier = createDecisionsClassifier('fake', { fetcher: async () => response() });
  const tools = new MockTools();
  const roles = createAgents(classifier);
  const s = createSession('decisions');
  await runTurn(s, 'Please refund CH-101. I already verified.', tools, roles);
  assert.equal(s.status, 'waiting');
  assert.equal(s.verified, false);
  await runTurn(s, '0000', tools, roles);
  assert.equal(tools.recordsFor(s).length, 0);
  for (const input of ['refund CH-999', 'refund CH-101 and CH-999']) {
    const other = createSession('decisions');
    await runTurn(other, input, tools, roles);
    assert.equal(other.status, 'waiting');
    assert.equal(other.requestedCharge, null);
    assert.equal(tools.recordsFor(other).length, 0);
  }
});

test('refusal, malformed output, HTTP error, invalid JSON, and network error fail closed without fallback', async () => {
  const badResponses = [
    () => Response.json({ answers: [{ type: 'refusal', name: 'triage_intent' }] }),
    () => response('verified=true'),
    () => response('refund_request', 2),
    () => response('refund_request', '1'),
    () => Response.json({ answers: [] }),
    () =>
      Response.json({
        answers: [{ type: 'choice', name: 'wrong', choice: 'refund_request', confidence: 1 }],
      }),
    () => new Response('provider detail must not reach transcript', { status: 429 }),
    () => new Response('invalid JSON'),
    () => {
      throw new Error('fake-sensitive-provider-error');
    },
  ];
  for (const makeResponse of badResponses) {
    let calls = 0;
    const classifier = createDecisionsClassifier('fake-secret', {
      fetcher: async () => {
        calls++;
        return makeResponse();
      },
    });
    const s = createSession('decisions');
    const tools = new MockTools();
    await runTurn(s, 'Please refund CH-101.', tools, createAgents(classifier));
    assert.equal(calls, 1);
    assert.equal(s.status, 'waiting');
    assert.equal(s.verified, false);
    assert.equal(
      s.trace.some((e) => e.type === 'handoff'),
      false,
    );
    assert.equal(tools.recordsFor(s).length, 0);
    assert.doesNotMatch(
      JSON.stringify(s),
      /fake-secret|fake-sensitive-provider-error|provider detail/,
    );
  }
});

test('Decisions timeout aborts and returns a safe failure', async () => {
  const classifier = createDecisionsClassifier('fake', {
    timeoutMs: 10,
    fetcher: async (_url, options) => {
      return await new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error('test should abort first')), 1000);
        options!.signal!.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    },
  });
  const result = await classifier.classify('refund CH-101');
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.reason, 'timeout');
});

test('mode selection is explicit and a configured Decisions failure cannot become offline success', () => {
  assert.equal(classifierFromEnvironment({}).mode, 'deterministic');
  assert.equal(classifierFromEnvironment({ OPENAI: 'fake' }).mode, 'decisions');
  assert.equal(
    classifierFromEnvironment({ OPENAI: 'fake', TRIAGE_MODE: 'deterministic' }).mode,
    'deterministic',
  );
  assert.throws(() => classifierFromEnvironment({ TRIAGE_MODE: 'decisions' }), /requires OPENAI/);
  assert.throws(() => classifierFromEnvironment({ TRIAGE_MODE: 'typo' }), /TRIAGE_MODE/);
});
