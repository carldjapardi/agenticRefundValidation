import type { Message, Role, Session } from './session.js';
import type { ToolResult } from './tools.js';
import {
  deterministicClassifier,
  MIN_INTENT_CONFIDENCE,
  type TriageClassifier,
  type TriageDecision,
} from './decisions.js';
import { extractCharges, normalizeChargeReferences } from './charges.js';
import type { ReplyPurpose, TriageReply, TriageResponder } from './triage-replies.js';

export type Action = (
  | { type: 'handoff'; to: Role; charge?: string; verified?: true }
  | { type: 'tool'; tool: 'verify_identity'; code: string }
  | { type: 'tool'; tool: 'issue_refund'; charge: string }
  | { type: 'wait'; text: string }
  | {
      type: 'finish';
      text: string;
      reference?: string;
      refundOutcome?: 'issued' | 'already_refunded';
    }
) & { triageDecision?: TriageDecision; triageReply?: TriageReply };
export interface Context {
  session: Readonly<Session>;
  input: string;
  result?: ToolResult;
}
export type Agent = (context: Context) => Action | Promise<Action>;

function buildTriageContext(transcript: readonly Message[], input: string): string {
  const messages = transcript.slice(-8);
  if (messages.length === 1) return normalizeChargeReferences(input);
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      text: normalizeChargeReferences(message.text),
    })),
  );
}

function latestCustomerCharges(transcript: readonly Message[]): string[] {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const message = transcript[index]!;
    if (message.role !== 'customer') continue;
    const charges = extractCharges(message.text);
    if (charges.length > 0) return charges;
  }
  return [];
}

export function createTriage(classifier: TriageClassifier, responder?: TriageResponder): Agent {
  return async ({ input, session }) => {
    const context = buildTriageContext(session.transcript, input);
    const explicitCommand = /^refund\s+CH-101[.!]?$/i.test(normalizeChargeReferences(input).trim());
    const decision: TriageDecision = explicitCommand
      ? {
          source: 'deterministic',
          outcome: 'classified',
          intent: 'refund_request',
          reason: 'explicit_refund_command',
        }
      : await classifier.classify(context);
    const finish = (text: string): Action => ({ type: 'finish', text, triageDecision: decision });
    const wait = async (purpose: ReplyPurpose, fallback: string): Promise<Action> => {
      const generated: TriageReply = responder
        ? await responder.respond(context, purpose, fallback)
        : { source: 'deterministic', outcome: 'fallback', text: fallback };
      return {
        type: 'wait',
        text: `${generated.text} No refund has been issued.`,
        triageDecision: decision,
        triageReply: generated,
      };
    };
    if (decision.outcome !== 'classified') {
      return {
        type: 'wait',
        text: 'I couldn’t interpret your request right now. Nothing has been refunded. You can try again here in a moment.',
        triageDecision: decision,
      };
    }
    if (decision.source === 'decisions' && (decision.confidence ?? 0) < MIN_INTENT_CONFIDENCE) {
      return wait(
        'clarify_intent',
        'Just to confirm, would you like me to start a refund for CH-101?',
      );
    }
    if (decision.intent === 'no_refund_requested')
      return finish('Understood. I won’t start a refund. No refund was issued.');
    if (decision.intent === 'refund_question')
      return wait(
        'explain_process',
        'I can help refund CH-101 ($25.00) after an identity check. Would you like to request that refund?',
      );
    if (decision.intent !== 'refund_request')
      return wait(
        'clarify_intent',
        'Hi! I can help with a refund for CH-101 ($25.00). Would you like to request one?',
      );
    const charges = latestCustomerCharges(session.transcript);
    if (charges.length !== 1 || charges[0] !== 'CH-101') {
      return wait(
        'identify_charge',
        'This demo supports one charge: CH-101 ($25.00). Please type CH-101 if that is the charge you want to refund.',
      );
    }
    return { type: 'handoff', to: 'Identity', charge: 'CH-101', triageDecision: decision };
  };
}

export const triage = createTriage(deterministicClassifier);

export const identity: Agent = ({ session, input, result }) => {
  if (!session.codeRequested) {
    return {
      type: 'wait',
      text: 'Before I refund CH-101 for $25.00, please enter your four-digit verification code.',
    };
  }
  if (!result) {
    if (/^(?:cancel|stop|never mind|nevermind)[.!]?$/i.test(input.trim()))
      return { type: 'finish', text: 'Cancelled. No refund was issued.' };
    if (!/^\d{4}$/.test(input.trim()))
      return {
        type: 'wait',
        text: 'I’ve already noted your refund request for CH-101. Please enter only your four-digit verification code to continue. This message did not use a verification attempt.',
      };
    return { type: 'tool', tool: 'verify_identity', code: input.trim() };
  }
  if (result.tool !== 'verify_identity')
    throw new Error('Identity received an unexpected tool result.');
  if (!result.success) {
    return {
      type: 'finish',
      text: 'Verification failed. No refund was issued. For this demo, one attempt is allowed. Start a new chat to try again.',
    };
  }
  return { type: 'handoff', to: 'Refund', verified: true };
};

export const refund: Agent = ({ session, result }) => {
  if (result?.tool === 'issue_refund') {
    return {
      type: 'finish',
      text: result.created
        ? `Your $25.00 refund for ${result.charge} has been issued. Your refund reference is ${result.reference}.`
        : `${result.charge} was already refunded. The existing refund reference is ${result.reference}. No additional refund was issued.`,
      reference: result.reference,
      refundOutcome: result.created ? 'issued' : 'already_refunded',
    };
  }
  return { type: 'tool', tool: 'issue_refund', charge: session.requestedCharge ?? '' };
};

export const agents: Record<Role, Agent> = { Triage: triage, Identity: identity, Refund: refund };
export function createAgents(
  classifier: TriageClassifier,
  responder?: TriageResponder,
): Record<Role, Agent> {
  return { ...agents, Triage: createTriage(classifier, responder) };
}
