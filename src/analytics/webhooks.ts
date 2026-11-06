import { Webhooks } from '@octokit/webhooks';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Json } from './model.ts';
import { InvalidProjectEvent } from './ProjectEvent.ts';

export interface EventRecorder {

  record(deliveryId: string, name: string, payload: Json, receivedAt: Date): Promise<'stored' | 'duplicate' | 'ignored'>;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

class RequestError extends Error {

  readonly status: number;

  constructor(status: number) {
    super('Webhook request rejected.');
    this.status = status;
  }
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== 'string' || !value) throw new RequestError(400);
  return value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new RequestError(413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function webhookServer(secret: string, store: EventRecorder): Server {
  const verifier = new Webhooks({ secret });
  const server = createServer({ requestTimeout: 5_000, headersTimeout: 5_000 }, async (request, response) => {
    const receivedAt = new Date();
    response.setHeader('Connection', 'close');
    try {
      if (request.url !== '/api/github/webhooks') throw new RequestError(404);
      if (request.method !== 'POST') throw new RequestError(405);
      if (header(request, 'content-type').split(';')[0]?.trim() !== 'application/json') throw new RequestError(415);
      const id = header(request, 'x-github-delivery');
      if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new RequestError(400);
      const name = header(request, 'x-github-event');
      const signature = header(request, 'x-hub-signature-256');
      if (!/^sha256=[\da-f]{64}$/i.test(signature)) throw new RequestError(401);
      const length = Number(request.headers['content-length'] ?? 0);
      if (length > MAX_BODY_BYTES) throw new RequestError(413);
      const body = await readBody(request);
      if (!await verifier.verify(body, signature)) throw new RequestError(401);
      let payload: Json;
      try { payload = JSON.parse(body) as Json; } catch { throw new RequestError(400); }
      const result = name === 'ping' ? 'ignored' : await store.record(id, name, payload, receivedAt);
      console.log(JSON.stringify({ event: 'webhook_received', deliveryId: id, result }));
      response.writeHead(204).end();
    } catch (error) {
      const status = error instanceof RequestError ? error.status : error instanceof InvalidProjectEvent ? 422 : 503;
      console.error(JSON.stringify({ event: 'webhook_failed', status, errorType: error instanceof Error ? error.name : 'UnknownError' }));
      if (!response.headersSent) response.writeHead(status).end();
    }
  });
  server.setTimeout(8_000, socket => socket.destroy());
  return server;
}
