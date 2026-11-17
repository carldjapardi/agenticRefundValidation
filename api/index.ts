import { hostedFromEnvironment, HostedConfigurationError } from '../src/hosted.js';

export function createApi(env: NodeJS.ProcessEnv = process.env) {
  let handler: ReturnType<typeof hostedFromEnvironment> | undefined;
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        handler ??= hostedFromEnvironment(env);
        return await handler(request);
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof HostedConfigurationError
                ? error.message
                : 'The refund desk is not configured. Please try again later.',
          },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    },
  };
}

export default createApi();
