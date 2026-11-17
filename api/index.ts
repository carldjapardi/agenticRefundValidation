import { hostedFromEnvironment } from '../src/hosted.js';

let handler: ReturnType<typeof hostedFromEnvironment> | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      handler ??= hostedFromEnvironment(process.env);
      return await handler(request);
    } catch {
      return Response.json(
        { error: 'The refund desk is not configured. Please try again later.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  },
};
