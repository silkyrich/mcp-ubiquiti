/**
 * Minimal, stateless MCP server over Streamable HTTP.
 *
 * Rather than depend on a Durable-Object-based agent, this implements the
 * JSON-RPC subset Claude's custom connector needs (initialize, tools/list,
 * tools/call, ping) directly. Each POST is a self-contained request answered
 * with a single application/json JSON-RPC response — no session state, which
 * suits a Worker and survives cold starts.
 */

import { UnifiClient, UnifiConfig, UnifiError } from "./unifi";
import { HomeClient, HomeConfig, HomeError } from "./home";
import { HomeStateClient } from "./state";
import { TOOLS, TOOLS_BY_NAME } from "./tools";
import { log, logError } from "./log";

/** Local tools that exist only when the home link is configured. */
const HOME_LOCAL_TOOLS = [
  {
    name: "home_log",
    description:
      "The change log of everything done through the home link: who asked, which tool, the arguments and whether it worked, newest first. Answers 'who gave him the afternoon off?' and 'what happened at 15:30?'.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many entries (default 50, max 500)." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "mcp-ubiquiti", version: "0.1.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

function result(id: any, res: unknown) {
  return { jsonrpc: "2.0", id, result: res };
}
function error(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatch(
  req: JsonRpcRequest,
  cfg: UnifiConfig,
  home?: HomeConfig,
  state?: HomeStateClient,
): Promise<object | null> {
  switch (req.method) {
    case "initialize":
      return result(req.id, {
        protocolVersion: req.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    // Notifications (no id / no response expected)
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return result(req.id, {});

    case "tools/list": {
      const local = TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
      // Tools advertised by the home service, if one is configured. Names
      // that collide with a local tool are dropped so the local one wins.
      const remote = home ? await new HomeClient(home).tools() : [];
      const extra = home ? HOME_LOCAL_TOOLS : [];
      const taken = new Set([...local, ...extra].map((t) => t.name));
      return result(req.id, { tools: [...local, ...extra, ...remote.filter((t) => !taken.has(t.name))] });
    }

    case "tools/call": {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      const tool = TOOLS_BY_NAME.get(name);
      const homeClient = home ? new HomeClient(home) : undefined;
      const started = Date.now();
      if (!tool) {
        if (home && state && name === "home_log") {
          const entries = await state.recent(Number(args.limit) || 50);
          return result(req.id, { content: [{ type: "text", text: JSON.stringify({ entries }, null, 2) }] });
        }
        if (homeClient && (await homeClient.has(name))) {
          const record = (ok: boolean, summary: string) =>
            state?.log({ ts: new Date().toISOString(), actor: home!.actor, tool: name, args, ok, summary }).catch(() => {});
          try {
            const data = await homeClient.call(name, args);
            log("mcp.tool.ok", { tool: name, ms: Date.now() - started, via: "home" });
            // Read-only tools are not worth a log row; everything else is.
            if (!/^home_(groups|status|usage)$/.test(name)) await record(true, "ok");
            return result(req.id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
          } catch (e) {
            const status = e instanceof HomeError ? e.status : undefined;
            logError("mcp.tool.failed", { tool: name, ms: Date.now() - started, status, reason: (e as Error).message, via: "home" });
            await record(false, (e as Error).message.slice(0, 200));
            return result(req.id, { content: [{ type: "text", text: `Home service error: ${(e as Error).message}` }], isError: true });
          }
        }
        logError("mcp.tool.unknown", { tool: name });
        return error(req.id, -32602, `Unknown tool: ${name}`);
      }
      const client = new UnifiClient(cfg);
      try {
        const data = await tool.handler(client, args);
        log("mcp.tool.ok", { tool: name, ms: Date.now() - started });
        return result(req.id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        });
      } catch (e) {
        const isUnifi = e instanceof UnifiError;
        logError("mcp.tool.failed", {
          tool: name,
          ms: Date.now() - started,
          status: isUnifi ? (e as UnifiError).status : undefined,
          reason: (e as Error).message,
        });
        const msg = isUnifi
          ? `UniFi request failed (${(e as UnifiError).status}): ${(e as Error).message}`
          : `Tool error: ${(e as Error).message}`;
        return result(req.id, {
          content: [{ type: "text", text: msg }],
          isError: true,
        });
      }
    }

    default:
      return error(req.id, -32601, `Method not found: ${req.method}`);
  }
}

/**
 * Handle one Streamable-HTTP POST. Accepts a single JSON-RPC request or a
 * batch array; returns application/json. Notifications yield 202 with no body.
 */
export async function handleMcp(
  request: Request,
  cfg: UnifiConfig,
  home?: HomeConfig,
  state?: HomeStateClient,
): Promise<Response> {
  if (request.method === "GET") {
    // No server-initiated SSE stream in this stateless design.
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = await request.json();
  } catch {
    return Response.json(error(null, -32700, "Parse error"), { status: 400 });
  }

  const batch = Array.isArray(payload);
  const reqs: JsonRpcRequest[] = batch ? (payload as JsonRpcRequest[]) : [payload as JsonRpcRequest];
  const responses = (await Promise.all(reqs.map((r) => dispatch(r, cfg, home, state)))).filter(
    (r): r is object => r !== null,
  );

  if (responses.length === 0) {
    // Only notifications — nothing to return.
    return new Response(null, { status: 202 });
  }
  return Response.json(batch ? responses : responses[0]);
}
