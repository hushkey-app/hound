/**
 * WebSocket gateway — creates a server that upgrades HTTP to WebSocket (createWsGateway).
 *
 * @module
 */
import type { Hound } from '../hound/mod.ts';

/** Callback invoked when a new WebSocket connection is upgraded. Receives the socket and the HTTP request. */
export type WsConnectionHandler = (ws: WebSocket, req: Request) => void;

/** Options for creating the WebSocket gateway server. */
export type WsGatewayOptions = {
  /** Port to listen on. */
  port: number;
  /** Hostname to bind (default "0.0.0.0"). */
  hostname?: string;
  /** Hound instance (used by callers; gateway does not use it directly). */
  hound: Hound<any>;
  /** Optional callback invoked for each new WebSocket connection. */
  onConnection?: WsConnectionHandler;
};

/**
 * Start a WebSocket server on the given port and hostname. Upgrades HTTP requests with Upgrade: websocket.
 * Use the returned value to call shutdown() when stopping.
 *
 * @param options - Port, hostname, Hound instance, and optional onConnection callback
 * @returns The Deno server object (e.g. for shutdown)
 */
export function createWsGateway(options: WsGatewayOptions) {
  const { port, hostname = '0.0.0.0', onConnection } = options;

  const server = Deno.serve(
    { hostname, port },
    (req: Request): Response | Promise<Response> => {
      const upgrade = req.headers.get('upgrade') ?? '';
      if (upgrade.toLowerCase() !== 'websocket') {
        return new Response(null, {
          status: 426,
          statusText: 'Upgrade Required',
        });
      }

      try {
        const { socket, response } = Deno.upgradeWebSocket(req);

        socket.addEventListener('open', () => {
          onConnection?.(socket, req);
        });

        // Message handling (emit + queued/job_finished reply) is done in onConnection handler (handleWsConnection)

        return response;
      } catch (err) {
        console.error('ws.gateway upgrade error:', err);
        return new Response(null, { status: 500 });
      }
    },
  );

  return server;
}
