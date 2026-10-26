// Remote (HTTP) version: reachable from any device through a tunnel. URL path carries a secret token.
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.mjs";

const PORT = Number(process.env.PORT || 3459);
const TOKEN = process.env.MCP_TOKEN;
if (!TOKEN) { console.error("MCP_TOKEN missing"); process.exit(1); }
const ROUTE = `/mcp/${TOKEN}`;

http.createServer(async (req, res) => {
  const p = (req.url || "").split("?")[0];
  const t0 = Date.now();
  res.on("finish", () => console.log(new Date().toISOString(), req.method, p.replace(TOKEN, "<token>"), res.statusCode, `${Date.now() - t0}ms`));
  if (p.endsWith("/health")) { res.writeHead(200).end("ok"); return; }
  if (!p.endsWith(ROUTE)) { res.writeHead(404).end(); return; }
  if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400).end("bad json"); return; }
  const server = new McpServer({ name: "video-frames", version: "2.0.0" });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
  res.on("close", () => { transport.close(); server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, parsed); }
  catch (e) { console.error(new Date().toISOString(), "request error", e.message); if (!res.headersSent) res.writeHead(500).end(String(e)); }
}).listen(PORT, "127.0.0.1", () => console.log(`video-frames listening on 127.0.0.1:${PORT}`));
