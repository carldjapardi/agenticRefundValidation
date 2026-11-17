import type { Session } from './session.js';
import type { AgentTools, RefundRecord, ToolResult } from './tools.js';

export class StorageError extends Error {
  constructor(readonly code: string) {
    super('The session store could not complete this request.');
  }
}

export type Rpc = (name: string, parameters: Record<string, unknown>) => Promise<unknown>;

export function createRpc(url: string, secret: string, fetcher: typeof fetch = fetch): Rpc {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || !secret.trim()) {
    throw new Error('Hosted mode requires SUPABASE_URL (HTTPS) and SUPABASE_SECRET_KEY.');
  }
  return async (name, parameters) => {
    try {
      const response = await fetcher(new URL(`/rest/v1/rpc/${name}`, endpoint), {
        method: 'POST',
        headers: {
          apikey: secret,
          ...(!secret.startsWith('sb_secret_') ? { Authorization: `Bearer ${secret}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(8000),
      });
      // Void RPCs can return an empty 200/204 response instead of JSON null.
      const text = await response.text();
      const data: unknown = text.trim() ? JSON.parse(text) : null;
      if (!response.ok) {
        const code = isRecord(data) && typeof data.code === 'string' ? data.code : 'storage_error';
        throw new StorageError(code);
      }
      return data;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      // Provider bodies, connection details, keys, and arbitrary exception text stay private.
      throw new StorageError('storage_error');
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sessionFrom(value: unknown): Session {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !['Triage', 'Identity', 'Refund'].includes(String(value.currentRole)) ||
    !['ready', 'running', 'waiting', 'ended'].includes(String(value.status)) ||
    typeof value.verified !== 'boolean' ||
    !Array.isArray(value.transcript) ||
    !Array.isArray(value.trace)
  )
    throw new StorageError('invalid_state');
  return value as unknown as Session;
}

export class SupabaseStore {
  constructor(private readonly rpc: Rpc) {}

  async create(workspace: string, session: Session): Promise<Session> {
    return sessionFrom(
      await this.rpc('finchpay_create_session', {
        p_workspace: workspace,
        p_state: session,
      }),
    );
  }

  async claim(workspace: string, id: string, lease: string): Promise<Session> {
    return sessionFrom(
      await this.rpc('finchpay_claim_turn', {
        p_workspace: workspace,
        p_session: id,
        p_lease: lease,
      }),
    );
  }

  async save(workspace: string, session: Session, lease: string): Promise<void> {
    await this.rpc('finchpay_save_turn', {
      p_workspace: workspace,
      p_session: session.id,
      p_lease: lease,
      p_state: session,
    });
  }

  async release(workspace: string, id: string, lease: string): Promise<void> {
    await this.rpc('finchpay_release_turn', {
      p_workspace: workspace,
      p_session: id,
      p_lease: lease,
    });
  }

  async read(
    workspace: string,
    id: string,
  ): Promise<{ session: Session; refunds: RefundRecord[] }> {
    const value = await this.rpc('finchpay_read_session', {
      p_workspace: workspace,
      p_session: id,
    });
    if (!isRecord(value) || !Array.isArray(value.refunds)) throw new StorageError('invalid_state');
    return { session: sessionFrom(value.session), refunds: value.refunds as RefundRecord[] };
  }

  tools(workspace: string, id: string, lease: string): AgentTools {
    // An in-process flag cannot substitute for either tool success or the durable DB proof.
    const verified = new WeakSet<Session>();
    const parameters = { p_workspace: workspace, p_session: id, p_lease: lease };
    return {
      verify_identity: async (session, code): Promise<ToolResult> => {
        if (session.id !== id) throw new StorageError('invalid_state');
        const success = await this.rpc('finchpay_verify_identity', { ...parameters, p_code: code });
        if (typeof success !== 'boolean') throw new StorageError('invalid_state');
        if (success) verified.add(session);
        else verified.delete(session);
        return { tool: 'verify_identity', success };
      },
      issue_refund: async (session, charge): Promise<ToolResult> => {
        if (session.id !== id || !session.verified || !verified.has(session)) {
          throw new Error('Identity must be verified in this session before a refund.');
        }
        if (charge !== 'CH-101' || session.requestedCharge !== charge) {
          throw new Error('Only the requested CH-101 charge can be refunded.');
        }
        const value = await this.rpc('finchpay_issue_refund', { ...parameters, p_charge: charge });
        if (
          !isRecord(value) ||
          typeof value.reference !== 'string' ||
          typeof value.created !== 'boolean' ||
          value.charge !== charge ||
          value.amount !== 25
        ) {
          throw new StorageError('invalid_state');
        }
        return {
          tool: 'issue_refund',
          success: true,
          reference: value.reference,
          charge,
          amount: 25,
          created: value.created,
        };
      },
    };
  }
}
