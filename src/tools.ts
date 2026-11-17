import { record, type Session } from './session.js';

export type ToolResult =
  | { tool: 'verify_identity'; success: boolean }
  | {
      tool: 'issue_refund';
      success: true;
      reference: string;
      charge: string;
      amount: number;
      created: boolean;
    };
export interface AgentTools {
  verify_identity(session: Session, code: string): ToolResult | Promise<ToolResult>;
  issue_refund(session: Session, charge: string): ToolResult | Promise<ToolResult>;
}

export interface RefundRecord {
  sessionId: string;
  reference: string;
  charge: string;
  amount: number;
}

/** One mock tool store per process. There are no network calls or durable writes. */
export class MockTools implements AgentTools {
  private readonly verifiedSessions = new WeakSet<Session>();
  private readonly refunds = new Map<string, RefundRecord>();

  verify_identity(session: Session, code: string): ToolResult {
    const success = code === '2468';
    if (success) this.verifiedSessions.add(session);
    else this.verifiedSessions.delete(session);
    return { tool: 'verify_identity', success };
  }

  issue_refund(session: Session, charge: string): ToolResult {
    // Enforce before every write, even if a caller bypasses the role dispatcher.
    if (!session.verified || !this.verifiedSessions.has(session)) {
      record(session, 'refund_denied', { reason: 'identity_not_verified', charge });
      throw new Error('Identity must be verified in this session before a refund.');
    }
    if (charge !== 'CH-101' || charge !== session.requestedCharge) {
      record(session, 'refund_denied', { reason: 'unsupported_charge', charge });
      throw new Error('Only the requested CH-101 charge can be refunded.');
    }
    // The mock has one customer. New chat never resets charge-level eligibility.
    const existing = this.refunds.get(charge);
    if (existing)
      return {
        tool: 'issue_refund',
        success: true,
        reference: existing.reference,
        charge,
        amount: existing.amount,
        created: false,
      };
    const refund = {
      sessionId: session.id,
      reference: `RF-${String(this.refunds.size + 1).padStart(3, '0')}`,
      charge,
      amount: 25,
    };
    this.refunds.set(charge, refund);
    return {
      tool: 'issue_refund',
      success: true,
      reference: refund.reference,
      charge,
      amount: refund.amount,
      created: true,
    };
  }

  recordsFor(session: Session): RefundRecord[] {
    return [...this.refunds.values()]
      .filter((refund) => refund.sessionId === session.id)
      .map((refund) => ({ ...refund }));
  }
}
