// The stdio bridge. A command-line agent starts `a2a-notes bridge` as a stdio MCP server. The bridge forwards each
// JSON-RPC message to the running service's HTTP endpoint with the client token, and forwards each reply back.
// All clients use the same service, store, and Slack scan.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export async function runBridge(url: string, token: string) {
  const remote = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const local = new StdioServerTransport();
  local.onmessage = (message: JSONRPCMessage) => {
    remote.send(message).catch(error => {
      if ('id' in message && message.id !== undefined && 'method' in message)
        void local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `A2A Notes service is not reachable: ${(error as Error).message}` } });
    });
  };
  remote.onmessage = message => { void local.send(message); };
  local.onclose = () => { void remote.close(); };
  await remote.start();
  await local.start();
}
