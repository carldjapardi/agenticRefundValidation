import type { Session, TraceEvent } from '../src/session.js';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element ${id}`);
  return value as T;
}
const input = element<HTMLInputElement>('message');
const send = element<HTMLButtonElement>('send');
const reset = element<HTMLButtonElement>('new-chat');
const exportButton = element<HTMLButtonElement>('export');
const transcript = element('transcript');
const error = element('error');
let session: Session | undefined;
let generation = 0;
let busy = false;

async function api<T>(path: string, message?: string): Promise<T> {
  const response = await fetch(
    path,
    message === undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Could not connect to the refund desk.');
  return value as T;
}

function showError(value: unknown): void {
  error.textContent =
    value instanceof Error ? value.message : 'Something went wrong. Please try again.';
  error.hidden = false;
}

function describe(event: TraceEvent): string {
  const d = event.detail;
  if (event.type === 'handoff') return `${d.from} → ${d.to}`;
  if (event.type === 'tool_call')
    return `${event.role} calls ${d.tool} ${JSON.stringify(d.arguments)}`;
  if (event.type === 'tool_result')
    return `${d.tool}: ${d.success ? 'success' : 'failed'}${d.reference ? ` · ${d.reference}` : ''}`;
  return `${event.type.replaceAll('_', ' ')} · ${JSON.stringify(d)}`;
}

function render(): void {
  transcript.replaceChildren();
  if (!session?.transcript.length) {
    const welcome = document.createElement('div');
    welcome.className = 'welcome';
    const icon = document.createElement('div');
    icon.className = 'welcome-icon';
    icon.textContent = '↩';
    const title = document.createElement('h3');
    title.textContent = 'Let’s get it sorted.';
    const text = document.createElement('p');
    text.textContent = 'Tell us the charge you’d like refunded. We’ll take it from there.';
    welcome.append(icon, title, text);
    transcript.append(welcome);
  }
  for (const message of session?.transcript ?? []) {
    const row = document.createElement('div');
    row.className = `message ${message.role}`;
    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent = message.role === 'customer' ? 'YOU' : 'FINCHPAY';
    const bubble = document.createElement('p');
    bubble.textContent = message.text;
    row.append(label, bubble);
    transcript.append(row);
  }
  transcript.scrollTop = transcript.scrollHeight;
  const ended = session?.status === 'ended';
  input.disabled = busy || !session || ended;
  send.disabled = input.disabled;
  send.textContent = busy ? 'Sending…' : 'Send ↗';
  exportButton.disabled = !session;
  element('triage-mode').textContent = !session
    ? 'CONNECTING'
    : session.triageMode === 'decisions'
      ? 'HYBRID TRIAGE'
      : 'DETERMINISTIC TRIAGE';
  element('session-status').textContent = !session
    ? 'Connecting'
    : ended
      ? session.refundOutcome === 'already_refunded'
        ? 'Already refunded'
        : session.refundReference
          ? 'Refund issued'
          : 'Chat ended'
      : session.verified
        ? 'Verified'
        : 'Unverified';
  element('session-status').classList.toggle('success', Boolean(session?.refundReference));
  input.placeholder = ended
    ? 'Chat ended. Start a new chat to continue.'
    : session?.currentRole === 'Identity'
      ? 'Enter your verification code…'
      : 'Tell us which charge to refund…';
  input.inputMode = session?.currentRole === 'Identity' ? 'numeric' : 'text';
  const index = session?.currentRole === 'Refund' ? 2 : session?.currentRole === 'Identity' ? 1 : 0;
  ['step-triage', 'step-identity', 'step-refund'].forEach((id, i) => {
    element(id).className =
      i < index || (ended && session?.refundReference) ? 'complete' : i === index ? 'active' : '';
  });
  element('trace-count').textContent = `${session?.trace.length ?? 0} events`;
  element('trace-session').textContent = session ? `Session ${session.id}` : '';
  const list = element('trace-events');
  list.replaceChildren();
  for (const event of session?.trace ?? []) {
    const item = document.createElement('li');
    item.textContent = `${String(event.sequence).padStart(2, '0')}  ${describe(event)}`;
    list.append(item);
  }
}

async function newChat(): Promise<void> {
  const current = ++generation;
  session = undefined;
  busy = true;
  input.value = '';
  error.hidden = true;
  render();
  try {
    const next = await api<Session>('/api/sessions');
    if (current !== generation) return;
    session = next;
  } catch (e) {
    if (current === generation) showError(e);
  } finally {
    if (current === generation) {
      busy = false;
      render();
      input.focus();
    }
  }
}

element<HTMLFormElement>('message-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!session || busy || session.status === 'ended' || !message) return;
  const current = generation;
  const id = session.id;
  busy = true;
  error.hidden = true;
  render();
  try {
    const next = await api<Session>(`/api/sessions/${id}/messages`, message);
    if (current !== generation) return;
    session = next;
    input.value = '';
  } catch (e) {
    if (current === generation) showError(e);
  } finally {
    // A reply from an old conversation can never repopulate a new chat.
    if (current === generation) {
      busy = false;
      render();
      input.focus();
    }
  }
});
reset.addEventListener('click', () => void newChat());
element('example').addEventListener('click', () => {
  if (input.disabled) return;
  input.value = 'Please refund CH-101.';
  input.focus();
});
exportButton.addEventListener('click', async () => {
  if (!session) return;
  const exportingSession = session.id;
  try {
    const response = await fetch(`/api/sessions/${exportingSession}/trace`);
    if (!response.ok) throw new Error('Could not export trace.');
    const blob = new Blob([JSON.stringify(await response.json(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `finchpay-${exportingSession}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    showError(e);
  }
});
void newChat();
