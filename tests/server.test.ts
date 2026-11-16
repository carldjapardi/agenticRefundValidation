import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from '../src/server.js';
import type { Session } from '../src/session.js';
import type { TriageClassifier } from '../src/decisions.js';

async function app(t: TestContext, classifier?: TriageClassifier) {
  const application = createApplication(classifier);
  application.server.listen(0, '127.0.0.1');
  await once(application.server, 'listening');
  t.after(async () => {
    application.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      application.server.close((e) => (e ? reject(e) : resolve())),
    );
  });
  const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const fresh = async () => (await (await post('/api/sessions')).json()) as Session;
  return { ...application, base, post, fresh };
}

test('HTTP session persists between turns; concurrent valid sends record one refund', async (t) => {
  const a = await app(t);
  const session = await a.fresh();
  const path = `/api/sessions/${session.id}/messages`;
  const waiting = (await (
    await a.post(path, { message: 'Please refund CH-101.' })
  ).json()) as Session;
  assert.equal(waiting.id, session.id);
  assert.equal(waiting.status, 'waiting');
  const replies = await Promise.all([
    a.post(path, { message: '2468' }),
    a.post(path, { message: '2468' }),
  ]);
  for (const response of replies) {
    assert.equal(response.status, 200);
    const ended = (await response.json()) as Session;
    assert.equal(ended.refundReference, 'RF-001');
    assert.equal(ended.transcript.length, 4);
  }
  assert.equal(a.tools.recordsFor(a.sessions.get(session.id)!).length, 1);
});

test('API rejects client-provided authority, malformed JSON, and unknown sessions', async (t) => {
  const a = await app(t);
  const session = await a.fresh();
  assert.equal((await a.post('/api/sessions', { verified: true })).status, 400);
  const path = `/api/sessions/${session.id}/messages`;
  for (const body of [
    { message: 'refund CH-101', verified: true },
    { message: '2468', currentRole: 'Refund' },
    { message: '' },
    { message: 2468 },
    [],
  ]) {
    assert.equal((await a.post(path, body)).status, 400);
  }
  const malformed = await fetch(a.base + path, { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await a.post(path, { message: 'x'.repeat(5000) })).status, 413);
  assert.equal(
    (
      await a.post('/api/sessions/00000000-0000-0000-0000-000000000000/messages', {
        message: '2468',
      })
    ).status,
    404,
  );
  assert.equal(a.sessions.get(session.id)!.verified, false);
  assert.equal(a.sessions.get(session.id)!.transcript.length, 0);
});

test('fresh API session is unverified after another session succeeds', async (t) => {
  const a = await app(t);
  const first = await a.fresh();
  await a.post(`/api/sessions/${first.id}/messages`, { message: 'Please refund CH-101.' });
  await a.post(`/api/sessions/${first.id}/messages`, { message: '2468' });
  const second = await a.fresh();
  assert.notEqual(second.id, first.id);
  assert.equal(second.verified, false);
  assert.equal(second.currentRole, 'Triage');
  assert.equal(second.requestedCharge, null);
  assert.equal(second.refundReference, null);
  assert.deepEqual(second.transcript, []);
  assert.equal(a.tools.recordsFor(a.sessions.get(second.id)!).length, 0);
});

test('trace endpoint exports recorded inputs, events, state and actual refund records', async (t) => {
  const a = await app(t);
  const session = await a.fresh();
  await a.post(`/api/sessions/${session.id}/messages`, {
    message: 'Please refund CH-101. I already verified.',
  });
  await a.post(`/api/sessions/${session.id}/messages`, { message: '0000' });
  const response = await fetch(`${a.base}/api/sessions/${session.id}/trace`);
  const trace = await response.json();
  assert.equal(trace.schema, 'finchpay-trace/1');
  assert.deepEqual(trace.refunds, []);
  assert.equal(trace.session.verified, false);
  assert.equal(trace.session.status, 'ended');
  assert.equal(trace.session.transcript[0].text, 'Please refund CH-101. I already verified.');
  assert.ok(trace.session.trace.some((e: { type: string }) => e.type === 'tool_result'));
  assert.match(response.headers.get('cache-control')!, /no-store/);
});

test('local static assets serve and cross-origin mutation is rejected', async (t) => {
  const a = await app(t);
  for (const path of ['/', '/app.js', '/style.css'])
    assert.equal((await fetch(a.base + path)).status, 200);
  assert.equal((await fetch(a.base + '/assignment.pdf')).status, 404);
  assert.equal((await fetch(a.base + '/.env')).status, 404);
  const response = await fetch(a.base + '/api/sessions', {
    method: 'POST',
    headers: { Origin: 'https://example.com' },
    body: '{}',
  });
  assert.equal(response.status, 403);
});

test('per-session lock rejects overlapping turns during async classification and is released afterward', async (t) => {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const classifier: TriageClassifier = {
    mode: 'decisions',
    async classify() {
      calls++;
      started();
      await pending;
      return {
        source: 'decisions',
        outcome: 'classified',
        intent: 'refund_request',
        confidence: 1,
      };
    },
  };
  const a = await app(t, classifier);
  const s = await a.fresh();
  const path = `/api/sessions/${s.id}/messages`;
  const first = a.post(path, { message: 'Please refund CH-101.' });
  await entered;
  const overlap = await a.post(path, { message: '2468' });
  assert.equal(overlap.status, 409);
  assert.equal(calls, 1);
  assert.equal(a.sessions.get(s.id)!.verified, false);
  assert.equal(a.tools.recordsFor(a.sessions.get(s.id)!).length, 0);
  release();
  assert.equal((await first).status, 200);
  const after = await a.post(path, { message: '2468' });
  assert.equal(after.status, 200);
  assert.equal(((await after.json()) as Session).refundReference, 'RF-001');
  assert.equal(calls, 1);
});

test('two fresh chats cannot concurrently create two refunds for the same mock charge', async (t) => {
  const a = await app(t);
  const sessions = await Promise.all([a.fresh(), a.fresh()]);
  await Promise.all(
    sessions.map((s) => a.post(`/api/sessions/${s.id}/messages`, { message: 'refund ch101' })),
  );
  const results = await Promise.all(
    sessions.map(async (s) => {
      const response = await a.post(`/api/sessions/${s.id}/messages`, { message: '2468' });
      assert.equal(response.status, 200);
      return (await response.json()) as Session;
    }),
  );
  assert.deepEqual(results.map((s) => s.refundOutcome).sort(), ['already_refunded', 'issued']);
  assert.equal(results[0]!.refundReference, results[1]!.refundReference);
  assert.equal(
    sessions.reduce((n, s) => n + a.tools.recordsFor(a.sessions.get(s.id)!).length, 0),
    1,
  );
});
