import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createSession, type Session } from './session.js';
import { runTurn } from './loop.js';
import { MockTools } from './tools.js';
import { createAgents } from './agents.js';
import {
  classifierFromEnvironment,
  deterministicClassifier,
  type TriageClassifier,
} from './decisions.js';
import { createTriageResponder, type TriageResponder } from './triage-replies.js';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= 4096) chunks.push(Buffer.from(chunk));
  }
  if (bytes > 4096) throw new HttpError(413, 'Message is too large.');
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Expected a JSON object.');
  }
}

export function createApplication(
  classifier: TriageClassifier = deterministicClassifier,
  responder?: TriageResponder,
) {
  const sessions = new Map<string, Session>();
  const tools = new MockTools();
  const roles = createAgents(classifier, responder);
  const inFlight = new Set<string>();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const assets: Record<string, [string, string]> = {
    '/': ['web/index.html', 'text/html; charset=utf-8'],
    '/app.js': ['dist/web/app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const port = (server.address() as { port: number }).port;
      if (
        request.headers.origin &&
        ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(request.headers.origin)
      ) {
        throw new HttpError(403, 'Cross-origin requests are not supported.');
      }
      if (request.method === 'GET' && assets[path]) {
        const [file, contentType] = assets[path];
        const content = await readFile(resolve(root, file));
        response.writeHead(200, { 'Content-Type': contentType });
        response.end(content);
        return;
      }
      if (request.method === 'POST' && path === '/api/sessions') {
        const input = await body(request);
        if (Object.keys(input).length)
          throw new HttpError(400, 'Session state is managed by the server.');
        const session = createSession(classifier.mode);
        sessions.set(session.id, session);
        json(201, session);
        return;
      }
      const match = path.match(/^\/api\/sessions\/([a-f0-9-]{36})\/(messages|trace)$/);
      if (match) {
        const session = sessions.get(match[1]!);
        if (!session) throw new HttpError(404, 'Session expired or not found. Start a new chat.');
        if (request.method === 'POST' && match[2] === 'messages') {
          const input = await body(request);
          if (
            Object.keys(input).length !== 1 ||
            typeof input.message !== 'string' ||
            !input.message.trim() ||
            input.message.length > 1000
          ) {
            throw new HttpError(400, 'Send only a message between 1 and 1000 characters.');
          }
          // The lock spans the entire async turn, including the external Triage request.
          if (inFlight.has(session.id))
            throw new HttpError(409, 'A reply is already in progress for this chat. Please wait.');
          inFlight.add(session.id);
          try {
            await runTurn(session, input.message.trim(), tools, roles);
          } finally {
            inFlight.delete(session.id);
          }
          json(200, session);
          return;
        }
        if (request.method === 'GET' && match[2] === 'trace') {
          json(200, {
            schema: 'finchpay-trace/1',
            exportedAt: new Date().toISOString(),
            source: 'server-recorded events; trace export endpoint',
            session,
            refunds: tools.recordsFor(session),
          });
          return;
        }
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      json(error instanceof HttpError ? error.status : 500, {
        error:
          error instanceof HttpError ? error.message : 'Internal server error. Start a new chat.',
      });
    }
  });
  return { server, sessions, tools };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Could not load .env. Check its format and permissions.');
  }
  const port = Number(process.env.PORT ?? 3000);
  const classifier = classifierFromEnvironment(process.env);
  const responder =
    classifier.mode === 'decisions' ? createTriageResponder(process.env.OPENAI ?? '') : undefined;
  const { server } = createApplication(classifier, responder);
  server.listen(port, '127.0.0.1', () =>
    console.log(`FinchPay local: http://localhost:${port} (${classifier.mode} triage)`),
  );
}
