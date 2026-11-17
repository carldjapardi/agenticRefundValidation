import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createSession, type Session } from '../src/session.js';

/** Minimal DOM adapter: run the actual compiled client against controllable responses. */
class Element {
  disabled = false;
  value = '';
  textContent = '';
  hidden = false;
  className = '';
  placeholder = '';
  inputMode = '';
  href = '';
  download = '';
  scrollTop = 0;
  scrollHeight = 0;
  readonly children: Element[] = [];
  readonly handlers = new Map<string, (event: { preventDefault(): void }) => unknown>();
  readonly classList = { toggle() {} };
  focus() {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren() {
    this.children.length = 0;
  }
  addEventListener(name: string, handler: (event: { preventDefault(): void }) => unknown) {
    this.handlers.set(name, handler);
  }
  click() {
    return this.handlers.get('click')?.({ preventDefault() {} });
  }
}

async function client(t: TestContext, startupError?: string) {
  const elements = new Map<string, Element>();
  const created: Element[] = [];
  const requests: { path: string; resolve: (response: Response) => void }[] = [];
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const savedFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      createElement() {
        const element = new Element();
        created.push(element);
        return element;
      },
    },
  });
  globalThis.fetch = (input) =>
    new Promise<Response>((resolve) => requests.push({ path: String(input), resolve }));
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  // Cache-bust each test so the real module registers its listeners afresh.
  await import(`../web/app.js?test=${Math.random()}`);
  const get = (id: string) => elements.get(id)!;
  const respond = async (index: number, value: unknown, status = 200) => {
    assert.ok(requests[index]);
    requests[index].resolve(new Response(JSON.stringify(value), { status }));
    await setImmediate();
  };
  const first = createSession();
  await respond(0, startupError ? { error: startupError } : first, startupError ? 503 : 200);
  const submit = (message: string) => {
    get('message').value = message;
    return get('message-form').handlers.get('submit')!({ preventDefault() {} });
  };
  return { get, respond, submit, first, created, requests };
}

test('New chat during a pending send rejects the old response and preserves the fresh session', async (t) => {
  const c = await client(t);
  const pending = c.submit('Please refund CH-101.');
  assert.equal(c.get('send').disabled, true);
  c.get('new-chat').click();
  assert.equal(c.get('message').value, '');
  const fresh = createSession();
  await c.respond(2, fresh);
  const old: Session = {
    ...c.first,
    currentRole: 'Refund',
    verified: true,
    status: 'ended',
    refundReference: 'RF-OLD',
    transcript: [{ role: 'assistant', text: 'OLD REFUND' }],
  };
  await c.respond(1, old);
  await pending;
  assert.equal(c.get('session-status').textContent, 'Unverified');
  assert.equal(c.get('message').disabled, false);
  assert.match(c.get('trace-session').textContent, new RegExp(fresh.id));
  assert.equal(
    c.created.some((e) => e.textContent === 'OLD REFUND'),
    false,
  );
});

test('client ignores a second submit while pending and renders customer HTML as text', async (t) => {
  const c = await client(t);
  const input = '<img src=x onerror=alert(1)> Please refund CH-101.';
  const pending = c.submit(input);
  await c.submit(input);
  assert.equal(c.requests.length, 2);
  await c.respond(1, {
    ...c.first,
    status: 'waiting',
    currentRole: 'Identity',
    transcript: [{ role: 'customer', text: input }],
  });
  await pending;
  assert.ok(c.created.some((e) => e.textContent === input));
  // The adapter exposes textContent, not HTML parsing; actual browser QA checks no img is created.
});

test('an export keeps its original session filename when New chat finishes first', async (t) => {
  const c = await client(t);
  const pending = c.get('export').click();
  assert.equal(c.requests[1]?.path, `/api/sessions/${c.first.id}/trace`);
  c.get('new-chat').click();
  await c.respond(2, createSession());
  await c.respond(1, { session: c.first });
  await pending;
  assert.ok(c.created.some((e) => e.download === `finchpay-${c.first.id}.json`));
});

test('startup failure leaves Connecting and New chat retries without stale error state', async (t) => {
  const c = await client(t, 'Hosted mode requires APP_ORIGIN.');
  assert.equal(c.get('session-status').textContent, 'Connection failed');
  assert.equal(c.get('triage-mode').textContent, 'UNAVAILABLE');
  assert.equal(c.get('message').disabled, true);
  assert.match(c.get('error').textContent, /APP_ORIGIN/);
  c.get('new-chat').click();
  assert.equal(c.get('session-status').textContent, 'Connecting');
  const fresh = createSession();
  await c.respond(1, fresh);
  assert.equal(c.get('session-status').textContent, 'Unverified');
  assert.equal(c.get('message').disabled, false);
  assert.equal(c.get('error').hidden, true);
});
