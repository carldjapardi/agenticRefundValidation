import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createAgents } from './agents.js';
import { classifierFromEnvironment, type TriageClassifier } from './decisions.js';
import { runTurn } from './loop.js';
import { createSession } from './session.js';
import { createRpc, StorageError, SupabaseStore } from './supabase.js';
import { createTriageResponder, type TriageResponder } from './triage-replies.js';

export class HostedConfigurationError extends Error {}

function httpsOrigin(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
      return url.origin;
  } catch {
    /* Report only the setting name, never the supplied value. */
  }
  throw new HostedConfigurationError(`${name} must be an HTTPS origin without a path.`);
}

const COOKIE = '__Host-finchpay-demo';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let text = '';
  let bytes = 0;
  const reader = request.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 4096) {
          await reader.cancel();
          throw new HttpError(413, 'Message is too large.');
        }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const value: unknown = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Expected a JSON object.');
  }
}

function workspaceToken(request: Request): string | undefined {
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export function createHostedHandler(options: {
  store: SupabaseStore;
  origins: string[];
  classifier: TriageClassifier;
  responder?: TriageResponder;
}): (request: Request) => Promise<Response> {
  const roles = createAgents(options.classifier, options.responder);
  const origins = new Set(
    options.origins.map((origin) => httpsOrigin(origin, 'APP_ORIGIN or Vercel deployment origin')),
  );
  return async (request) => {
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const json = (status: number, value: unknown) => Response.json(value, { status, headers });
    try {
      const origin = request.headers.get('origin');
      if (
        (origin && !origins.has(origin)) ||
        request.headers.get('sec-fetch-site') === 'cross-site'
      ) {
        throw new HttpError(403, 'Cross-origin requests are not supported.');
      }
      const url = new URL(request.url);
      // vercel.json routes related API paths to this shared function.
      const route = url.searchParams.get('route');
      const path = route === null ? url.pathname : `/api/${route}`;
      let token = workspaceToken(request);
      if (request.method === 'POST' && path === '/api/sessions') {
        const input = await readBody(request);
        if (Object.keys(input).length)
          throw new HttpError(400, 'Session state is managed by the server.');
        if (!token) {
          token = randomBytes(32).toString('hex');
          headers.set(
            'Set-Cookie',
            `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
          );
        }
        const workspace = createHash('sha256').update(token).digest('hex');
        return json(
          201,
          await options.store.create(workspace, createSession(options.classifier.mode)),
        );
      }
      const match = path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/(messages|trace)$/);
      if (!match || !token)
        throw new HttpError(404, 'Session expired or not found. Start a new chat.');
      const workspace = createHash('sha256').update(token).digest('hex');
      const id = match[1]!;
      if (request.method === 'GET' && match[2] === 'trace') {
        return json(200, {
          schema: 'finchpay-trace/1',
          exportedAt: new Date().toISOString(),
          source: 'server-recorded events; trace export endpoint',
          ...(await options.store.read(workspace, id)),
        });
      }
      if (request.method === 'POST' && match[2] === 'messages') {
        const input = await readBody(request);
        if (
          Object.keys(input).length !== 1 ||
          typeof input.message !== 'string' ||
          !input.message.trim() ||
          input.message.length > 1000
        ) {
          throw new HttpError(400, 'Send only a message between 1 and 1000 characters.');
        }
        const lease = randomUUID();
        const session = await options.store.claim(workspace, id, lease);
        let saved = false;
        try {
          await runTurn(
            session,
            input.message.trim(),
            options.store.tools(workspace, id, lease),
            roles,
          );
          await options.store.save(workspace, session, lease);
          saved = true;
          return json(200, session);
        } finally {
          if (!saved) await options.store.release(workspace, id, lease).catch(() => {});
        }
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      if (error instanceof StorageError && error.code === 'P0002') {
        return json(404, { error: 'Session expired or not found. Start a new chat.' });
      }
      if (error instanceof StorageError && error.code === '55P03') {
        return json(409, { error: 'A reply is already in progress for this chat. Please wait.' });
      }
      return json(503, { error: 'The refund desk is temporarily unavailable. Please try again.' });
    }
  };
}

export function hostedFromEnvironment(
  env: NodeJS.ProcessEnv,
): (request: Request) => Promise<Response> {
  const settings = { ...env };
  for (const key of [
    'APP_ORIGIN',
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY',
    'OPENAI',
    'TRIAGE_MODE',
  ]) {
    if (settings[key] !== undefined) settings[key] = settings[key]?.trim();
  }
  const missing = ['APP_ORIGIN', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY'].filter(
    (key) => !settings[key],
  );
  if (
    (settings.TRIAGE_MODE ?? (settings.OPENAI ? 'decisions' : 'deterministic')) === 'decisions' &&
    !settings.OPENAI
  )
    missing.push('OPENAI');
  if (missing.length) {
    throw new HostedConfigurationError(
      `Hosted mode requires ${missing.join(', ')}. Set these variables for this Vercel environment and redeploy.`,
    );
  }
  if (settings.TRIAGE_MODE && !['decisions', 'deterministic'].includes(settings.TRIAGE_MODE)) {
    throw new HostedConfigurationError('TRIAGE_MODE must be decisions or deterministic.');
  }
  const appOrigin = httpsOrigin(settings.APP_ORIGIN!, 'APP_ORIGIN');
  const supabaseUrl = httpsOrigin(settings.SUPABASE_URL!, 'SUPABASE_URL');
  const classifier = classifierFromEnvironment(settings);
  // Exact platform-provided aliases only; never trust an arbitrary *.vercel.app origin.
  const vercelOrigins = [
    settings.VERCEL_URL,
    settings.VERCEL_BRANCH_URL,
    settings.VERCEL_PROJECT_PRODUCTION_URL,
  ]
    .filter((host): host is string => Boolean(host))
    .map((host) => `https://${host}`);
  return createHostedHandler({
    store: new SupabaseStore(createRpc(supabaseUrl, settings.SUPABASE_SECRET_KEY!)),
    origins: [appOrigin, ...vercelOrigins],
    classifier,
    responder:
      classifier.mode === 'decisions' ? createTriageResponder(settings.OPENAI ?? '') : undefined,
  });
}
