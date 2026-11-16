import { randomUUID } from 'node:crypto';
import type { TriageMode } from './decisions.js';

export type Role = 'Triage' | 'Identity' | 'Refund';
export type Status = 'ready' | 'running' | 'waiting' | 'ended';
export interface Message {
  role: 'customer' | 'assistant';
  text: string;
}
export interface TraceEvent {
  sequence: number;
  role: Role;
  type: string;
  detail: Record<string, unknown>;
}
export interface Session {
  id: string;
  createdAt: string;
  triageMode: TriageMode;
  currentRole: Role;
  requestedCharge: string | null;
  verified: boolean;
  status: Status;
  codeRequested: boolean;
  refundReference: string | null;
  refundOutcome: 'issued' | 'already_refunded' | null;
  transcript: Message[];
  trace: TraceEvent[];
}

export function createSession(triageMode: TriageMode = 'deterministic'): Session {
  const session: Session = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    triageMode,
    currentRole: 'Triage',
    requestedCharge: null,
    verified: false,
    status: 'ready',
    codeRequested: false,
    refundReference: null,
    refundOutcome: null,
    transcript: [],
    trace: [],
  };
  record(session, 'session_started', { verified: false, status: 'ready', triageMode });
  return session;
}

export function record(session: Session, type: string, detail: Record<string, unknown>): void {
  session.trace.push({
    sequence: session.trace.length + 1,
    role: session.currentRole,
    type,
    detail,
  });
}

export function reply(session: Session, text: string): void {
  session.transcript.push({ role: 'assistant', text });
  record(session, 'assistant_reply', { text });
}
