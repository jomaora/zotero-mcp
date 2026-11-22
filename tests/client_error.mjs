import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: "node", args: [fileURLToPath(new URL("../server/index.js", import.meta.url))], env: { ...process.env, ZOTERO_LOCAL_PORT: process.argv[2] } });
const c = new Client({ name: "t", version: "0" }); await c.connect(t);
const r = await c.callTool({ name: "zotero_search", arguments: { query: "Trigger" } });
console.log(r.isError ? "[isError]" : "", r.content[0].text); await c.close();
