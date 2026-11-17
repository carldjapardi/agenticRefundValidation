import { agents, type Agent } from './agents.js';
import { record, reply, type Role, type Session } from './session.js';
import type { AgentTools, ToolResult } from './tools.js';

export const MAX_STEPS = 12;

/** Resume one customer turn; waiting and finishing both return to the caller. */
export async function runTurn(
  session: Session,
  input: string,
  tools: AgentTools,
  roles: Record<Role, Agent> = agents,
): Promise<void> {
  if (session.status === 'ended') return; // No new messages, tools, or effects after completion.
  session.transcript.push({ role: 'customer', text: input });
  record(session, 'customer_message', { text: input });
  const previousStatus = session.status;
  session.status = 'running';
  record(session, 'state_changed', { status: { from: previousStatus, to: 'running' } });
  let result: ToolResult | undefined;

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (session.currentRole === 'Triage')
        record(session, 'triage_classification_started', { mode: session.triageMode });
      const action = await roles[session.currentRole]({ session, input, result });
      if (session.currentRole === 'Triage' && action.triageDecision) {
        record(session, 'triage_decision', { ...action.triageDecision });
      }
      if (session.currentRole === 'Triage' && action.triageReply) {
        record(session, 'triage_reply', { ...action.triageReply });
      }
      record(session, 'loop_step', { step, action: action.type });
      switch (action.type) {
        case 'tool': {
          if (
            (action.tool === 'verify_identity' && session.currentRole !== 'Identity') ||
            (action.tool === 'issue_refund' && session.currentRole !== 'Refund')
          ) {
            throw new Error('Tool is not available to this role.');
          }
          record(session, 'tool_call', {
            tool: action.tool,
            arguments:
              action.tool === 'verify_identity' ? { code: action.code } : { charge: action.charge },
          });
          result =
            action.tool === 'verify_identity'
              ? await tools.verify_identity(session, action.code)
              : await tools.issue_refund(session, action.charge);
          record(session, 'tool_result', { ...result });
          break;
        }
        case 'handoff': {
          if (action.charge !== undefined) {
            if (session.currentRole !== 'Triage')
              throw new Error('Only Triage can select the charge.');
            session.requestedCharge = action.charge;
            record(session, 'state_changed', { requestedCharge: action.charge });
          }
          if (action.verified) {
            if (
              session.currentRole !== 'Identity' ||
              result?.tool !== 'verify_identity' ||
              !result.success
            ) {
              throw new Error('Verification requires a successful identity tool result.');
            }
            session.verified = true;
            record(session, 'state_changed', { verified: { from: false, to: true } });
          }
          record(session, 'handoff', { from: session.currentRole, to: action.to });
          session.currentRole = action.to;
          result = undefined; // Tool results belong to the role that requested them.
          break;
        }
        case 'wait':
          session.codeRequested = session.currentRole === 'Identity';
          session.status = 'waiting';
          record(session, 'state_changed', {
            codeRequested: session.codeRequested,
            status: 'waiting',
          });
          reply(session, action.text);
          record(session, 'loop_waiting', { reason: 'customer_input' });
          return;
        case 'finish':
          if (action.reference) {
            session.refundReference = action.reference;
            session.refundOutcome = action.refundOutcome ?? null;
            record(session, 'state_changed', {
              refundReference: action.reference,
              refundOutcome: session.refundOutcome,
            });
          }
          session.status = 'ended';
          record(session, 'state_changed', { status: 'ended' });
          reply(session, action.text);
          record(session, 'loop_ended', { reason: 'finished' });
          return;
      }
    }
    throw new Error(`Agent loop exceeded ${MAX_STEPS} steps.`);
  } catch (error) {
    session.status = 'ended';
    record(session, 'loop_error', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    reply(
      session,
      'This conversation stopped because of an internal error. No further actions will run. Start a new chat to continue.',
    );
    record(session, 'loop_ended', { reason: 'error', status: 'ended' });
  }
}
