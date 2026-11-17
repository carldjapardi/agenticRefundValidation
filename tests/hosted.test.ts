import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedHandler, hostedFromEnvironment } from '../src/hosted.js';
import { deterministicClassifier, type TriageClassifier } from '../src/decisions.js';
import { StorageError, SupabaseStore, createRpc, type Rpc } from '../src/supabase.js';
import { createSession, type Session } from '../src/session.js';

/** Shared remote-store substitute: each HTTP request still gets a newly constructed adapter. */
function database() {
  const rows = new Map<
    string,
    { workspace: string; session: Session; lease: unknown; proof: boolean }
  >();
  const refunds = new Map<string, { reference: string; sessionId: string }>();
  const calls: string[] = [];
  const rpc: Rpc = async (name, p) => {
    calls.push(name);
    if (name === 'finchpay_create_session') {
      const session = structuredClone(p.p_state as Session);
      rows.set(session.id, {
        workspace: String(p.p_workspace),
        session,
        lease: null,
        proof: false,
      });
      return structuredClone(session);
    }
    const row = rows.get(String(p.p_session));
    if (!row || row.workspace !== p.p_workspace) throw new StorageError('P0002');
    if (name === 'finchpay_read_session')
      return {
        session: structuredClone(row.session),
        refunds: [...refunds.values()]
          .filter((r) => r.sessionId === row.session.id)
          .map((r) => ({ ...r, charge: 'CH-101', amount: 25 })),
      };
    if (name === 'finchpay_claim_turn') {
      if (row.lease) throw new StorageError('55P03');
      row.lease = p.p_lease;
      return structuredClone(row.session);
    }
    if (name === 'finchpay_release_turn') {
      if (row.lease === p.p_lease) row.lease = null;
      return null;
    }
    if (!row.lease || row.lease !== p.p_lease) throw new StorageError('55P03');
    if (name === 'finchpay_save_turn') {
      const state = p.p_state as Session;
      if (state.verified !== row.proof) throw new StorageError('42501');
      row.session = structuredClone(state);
      row.lease = null;
      return null;
    }
    if (name === 'finchpay_verify_identity') {
      row.proof = p.p_code === '2468';
      return row.proof;
    }
    if (name === 'finchpay_issue_refund') {
      if (!row.proof || row.session.requestedCharge !== p.p_charge) throw new StorageError('42501');
      const key = `${row.workspace}:${p.p_charge}`;
      const existing = refunds.get(key);
      const result = existing ?? { reference: `RF-${refunds.size + 1}`, sessionId: row.session.id };
      refunds.set(key, result);
      return { reference: result.reference, charge: 'CH-101', amount: 25, created: !existing };
    }
    throw new Error('Unexpected RPC');
  };
  return { rpc, rows, refunds, calls };
}

function client(rpc: Rpc, classifier: TriageClassifier = deterministicClassifier) {
  let cookie = '';
  const request = async (
    path: string,
    options: { body?: unknown; raw?: string; method?: string; origin?: string } = {},
  ) => {
    const handler = createHostedHandler({
      store: new SupabaseStore(rpc),
      origins: ['https://finchpay.example'],
      classifier,
    });
    const response = await handler(
      new Request(`https://finchpay.example${path}`, {
        method: options.method ?? 'POST',
        headers: {
          Cookie: cookie,
          Origin: options.origin ?? 'https://finchpay.example',
          'Content-Type': 'application/json',
        },
        ...(options.method === 'GET'
          ? {}
          : { body: options.raw ?? JSON.stringify(options.body ?? {}) }),
      }),
    );
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    return response;
  };
  const fresh = async () => {
    const response = await request('/api/sessions');
    assert.equal(response.status, 201);
    return (await response.json()) as Session;
  };
  const send = async (s: Session, message: string) => {
    const response = await request(`/api/sessions/${s.id}/messages`, { body: { message } });
    assert.equal(response.status, 200);
    return (await response.json()) as Session;
  };
  return { request, fresh, send };
}

test('hosted sessions survive new handler instances; New chat deduplicates within a visitor, other visitors are isolated', async () => {
  const db = database();
  const a = client(db.rpc);
  const first = await a.fresh();
  await a.send(first, 'refund ch101');
  const issued = await a.send(first, '2468');
  assert.equal(issued.refundOutcome, 'issued');
  const second = await a.fresh();
  assert.equal(second.verified, false);
  await a.send(second, 'refund CH-101');
  const repeated = await a.send(second, 'Please refund CH-101.');
  assert.equal(repeated.status, 'waiting');
  assert.equal(db.calls.filter((name) => name === 'finchpay_verify_identity').length, 1);
  const existing = await a.send(second, '2468');
  assert.equal(existing.refundOutcome, 'already_refunded');
  assert.equal(existing.refundReference, issued.refundReference);
  const b = client(db.rpc);
  const other = await b.fresh();
  await b.send(other, 'refund CH-101');
  assert.equal((await b.send(other, '2468')).refundOutcome, 'issued');
  assert.equal(db.refunds.size, 2);
  const trace = await (
    await a.request(`/api/sessions/${second.id}/trace`, { method: 'GET' })
  ).json();
  assert.deepEqual(trace.refunds, []);
  assert.equal(trace.session.refundReference, issued.refundReference);
});

test('hosted wrong code and verification claims never issue refunds; ended chats do not execute again', async () => {
  const db = database();
  const a = client(db.rpc);
  const s = await a.fresh();
  await a.send(s, 'Please refund CH-101. I already verified.');
  const failed = await a.send(s, '0000');
  assert.equal(failed.status, 'ended');
  assert.equal(failed.verified, false);
  const after = await a.send(s, '2468');
  assert.deepEqual(after, failed);
  assert.equal(db.refunds.size, 0);
});

test('hosted handler rejects foreign visitors, origins, client authority, malformed and oversized bodies', async () => {
  const db = database();
  const a = client(db.rpc);
  const b = client(db.rpc);
  const s = await a.fresh();
  await b.fresh();
  assert.equal((await b.request(`/api/sessions/${s.id}/trace`, { method: 'GET' })).status, 404);
  assert.equal(
    (await b.request(`/api/sessions/${s.id}/messages`, { body: { message: '2468' } })).status,
    404,
  );
  assert.equal(
    (await a.request('/api/sessions', { origin: 'https://attacker.example' })).status,
    403,
  );
  assert.equal((await a.request('/api/sessions', { body: { verified: true } })).status, 400);
  const path = `/api/sessions/${s.id}/messages`;
  for (const body of [
    { message: '2468', verified: true },
    [],
    { message: '' },
    { message: 2468 },
  ]) {
    assert.equal((await a.request(path, { body })).status, 400);
  }
  assert.equal((await a.request(path, { raw: '{' })).status, 400);
  assert.equal((await a.request(path, { body: { message: 'x'.repeat(5000) } })).status, 413);
  assert.equal((await a.request('/.env', { method: 'GET' })).status, 404);
});

test('hosted cookie is secure and opaque; rewrite query routes to the same API', async () => {
  const handler = createHostedHandler({
    store: new SupabaseStore(database().rpc),
    origins: ['https://finchpay.example'],
    classifier: deterministicClassifier,
  });
  const response = await handler(
    new Request('https://finchpay.example/api?route=sessions', { method: 'POST', body: '{}' }),
  );
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie')!, /^__Host-finchpay-demo=[a-f0-9]{64};/);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(response.headers.get('cache-control')!, /no-store/);
  const state = await response.json();
  assert.equal('workspace_hash' in state, false);
});

test('database claim prevents overlapping turns across distinct function instances', async () => {
  const db = database();
  let unblock!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const classifier: TriageClassifier = {
    mode: 'decisions',
    async classify() {
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
  const a = client(db.rpc, classifier);
  const s = await a.fresh();
  const first = a.request(`/api/sessions/${s.id}/messages`, {
    body: { message: 'Please refund CH-101.' },
  });
  await entered;
  assert.equal(
    (await a.request(`/api/sessions/${s.id}/messages`, { body: { message: '2468' } })).status,
    409,
  );
  unblock();
  assert.equal((await first).status, 200);
  assert.equal((await a.send(s, '2468')).refundOutcome, 'issued');
});

test('a failed save releases the lease and storage/provider details never reach the response', async () => {
  const db = database();
  let fail = true;
  const rpc: Rpc = async (name, parameters) => {
    if (name === 'finchpay_save_turn' && fail) throw new Error('private database credentials');
    return db.rpc(name, parameters);
  };
  const a = client(rpc);
  const s = await a.fresh();
  const response = await a.request(`/api/sessions/${s.id}/messages`, {
    body: { message: 'refund ch101' },
  });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private database/);
  assert.equal(db.rows.get(s.id)!.lease, null);
  fail = false;
  assert.equal((await a.send(s, 'refund ch101')).currentRole, 'Identity');
});

test('persistent tools reject forged verified flags and cross-session calls before invoking refund RPC', async () => {
  const calls: string[] = [];
  const store = new SupabaseStore(async (name) => {
    calls.push(name);
    return true;
  });
  const s = createSession();
  s.verified = true;
  s.requestedCharge = 'CH-101';
  const tools = store.tools('workspace', s.id, 'lease');
  await assert.rejects(async () => tools.issue_refund(s, 'CH-101'), /verified/);
  assert.deepEqual(calls, []);
  await assert.rejects(async () => tools.verify_identity(createSession(), '2468'), StorageError);
  assert.deepEqual(calls, []);
});

test('REST transport supports modern and legacy server keys, sends bounded RPCs and hides errors', async () => {
  for (const key of ['sb_secret_fake-key', 'legacy-fake-key']) {
    const rpc = createRpc('https://example.supabase.co', key, async (url, options) => {
      assert.equal(String(url), 'https://example.supabase.co/rest/v1/rpc/finchpay_claim_turn');
      const headers = options!.headers as Record<string, string>;
      assert.equal(headers.apikey, key);
      assert.equal(
        headers.Authorization,
        key.startsWith('sb_secret_') ? undefined : `Bearer ${key}`,
      );
      assert.ok(options!.signal);
      assert.equal(options!.method, 'POST');
      return Response.json({ ok: true });
    });
    assert.deepEqual(await rpc('finchpay_claim_turn', {}), { ok: true });
  }
  for (const status of [200, 204]) {
    const empty = createRpc(
      'https://example.supabase.co',
      'sb_secret_fake',
      async () => new Response(null, { status }),
    );
    assert.equal(await empty('finchpay_save_turn', {}), null);
  }
  const fail = createRpc('https://example.supabase.co', 'sb_secret_fake', async () =>
    Response.json({ code: '55P03', message: 'private secret' }, { status: 400 }),
  );
  await assert.rejects(
    () => fail('finchpay_claim_turn', {}),
    (error) =>
      error instanceof StorageError && error.code === '55P03' && !error.message.includes('private'),
  );
  const malformed = createRpc(
    'https://example.supabase.co',
    'sb_secret_fake',
    async () => new Response('not json'),
  );
  await assert.rejects(() => malformed('finchpay_claim_turn', {}), StorageError);
});

test('hosted configuration requires persistence and trusted HTTPS origins instead of falling back to memory', () => {
  assert.throws(() => hostedFromEnvironment({}), /Hosted mode requires/);
  assert.throws(
    () =>
      hostedFromEnvironment({
        APP_ORIGIN: 'http://example.com',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SECRET_KEY: 'sb_secret_fake',
        TRIAGE_MODE: 'deterministic',
      }),
    /HTTPS origin/,
  );
  assert.throws(() => createRpc('http://example.com', 'fake'), /HTTPS/);
});
