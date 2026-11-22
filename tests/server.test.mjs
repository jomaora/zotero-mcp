// Tests du serveur MCP contre le faux Zotero (node --test).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeZotero } from "./fake_zotero.mjs";

const SERVER = fileURLToPath(new URL("../server/index.js", import.meta.url));

async function connect(port, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      ZOTERO_LOCAL_PORT: String(port),
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NODE_USE_ENV_PROXY: "1",
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content.map((c) => c.text).join("\n") };
  };
  return { client, call };
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

let fake;
let mcp;
before(async () => {
  fake = await startFakeZotero();
  mcp = await connect(fake.port);
});
after(async () => {
  await mcp?.client.close();
  await fake?.close();
});

test("les outils sont tous en lecture seule", async () => {
  const { tools } = await mcp.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "zotero_annotations",
    "zotero_children",
    "zotero_get_item",
    "zotero_get_note",
    "zotero_search",
  ]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
    for (const prop of Object.keys(t.inputSchema.properties ?? {})) assert.doesNotMatch(prop, /url|host|path/i);
  }
});

test("recherche : plusieurs mots, ordre libre, filtre de type", async () => {
  let r = await mcp.call("zotero_search", { query: "Auteur Exemple" });
  assert.match(r.text, /^1 résultat/);
  assert.match(r.text, /clé BOOK0001 \| book \| « Les Enfants d'Exemple/);
  assert.match(r.text, /Auteur, Jeanne \(author\)/);
  assert.match(r.text, /2 élément\(s\) enfant/);
  r = await mcp.call("zotero_search", { query: "Exemple Auteur", item_type: "book" });
  assert.match(r.text, /BOOK0001/);
  r = await mcp.call("zotero_search", { query: "Inexistant" });
  assert.match(r.text, /Aucun résultat/);
  r = await mcp.call("zotero_search", { query: "x", item_type: "book;rm" });
  assert.equal(r.isError, true);
  r = await mcp.call("zotero_search", { query: "idées" });
  assert.match(r.text, /STANDNOT \| note \| « Idées en vrac »/);
});

test("recherche : total signalé quand la liste est tronquée", async () => {
  const r = await mcp.call("zotero_search", { query: "e", limit: 1 });
  assert.match(r.text, /1 résultat\(s\) affiché\(s\) sur \d+/);
});

test("métadonnées : champs utiles, sans chemin local", async () => {
  const r = await mcp.call("zotero_get_item", { item_key: "BOOK0001" });
  assert.match(r.text, /^clé : BOOK0001\ntype : book\nauteurs : /);
  assert.match(r.text, /publisher : Éditions Fictives/);
  assert.match(r.text, /éléments enfants : 2/);
  const a = await mcp.call("zotero_get_item", { item_key: "ATTACH01" });
  assert.doesNotMatch(a.text, /secret|path :/);
  const n = await mcp.call("zotero_get_item", { item_key: "NOTE0001" });
  assert.match(n.text, /zotero_get_note/);
});

test("enfants : notes et pièces jointes, annotations exclues", async () => {
  const r = await mcp.call("zotero_children", { item_key: "BOOK0001" });
  assert.match(r.text, /Notes \(1\) :\n {2}clé NOTE0001 \| \d+ caractères \| début : Citations du livre/);
  assert.match(r.text, /Pièces jointes \(1\) :\n {2}clé ATTACH01 \| application\/pdf \| PDF \| linked_file/);
  assert.doesNotMatch(r.text, /ANN0/);
});

test("enfants : pagination au-delà de 100", async () => {
  const r = await mcp.call("zotero_children", { item_key: "BIGPAREN" });
  assert.match(r.text, /Notes \(150\)/);
  assert.doesNotMatch(r.text, /Attention/);
});

test("enfants : clé inconnue signalée (le vrai Zotero renvoie [] sur /children)", async () => {
  const r = await mcp.call("zotero_children", { item_key: "ZZZZZZZZ" });
  assert.equal(r.isError, true);
  assert.match(r.text, /404/);
});

test("note longue : lecture par tranches, conversion HTML", async () => {
  const first = await mcp.call("zotero_get_note", { note_key: "NOTE0001" });
  const h = first.text.match(/^Note NOTE0001 \| (\d+) caractères \| tranche 0-(\d+) \| suite : offset=(\d+)/);
  assert.ok(h, first.text.slice(0, 200));
  const total = Number(h[1]);
  assert.ok(total > 90000, `longueur ${total}`);
  const body = first.text.split("\n\n").slice(1).join("\n\n");
  assert.match(body, /^# Citations du livre/);
  assert.match(body, /« Les Hurons & leurs voisins » _\(note perso : voir p\. 12\)_ \*\*important\*\*/);
  assert.match(body, /Ligne avec nbsp été <pas une balise> a < b/);
  assert.match(body, /_ab_ fin\nligne suivante/);
  assert.match(body, /rouge \(Auteur 1991\)/);
  assert.match(body, /## Section/);
  assert.match(body, /- un\n- deux/);
  assert.doesNotMatch(body, /<\/?(p|div|span|em|h1)\b/);

  let offset = Number(h[3]);
  let text = body;
  while (offset < total) {
    const r = await mcp.call("zotero_get_note", { note_key: "NOTE0001", offset, max_chars: 50000 });
    const m = r.text.match(/tranche (\d+)-(\d+) \| (suite : offset=(\d+)|fin de la note)/);
    assert.ok(m, r.text.slice(0, 200));
    assert.equal(Number(m[1]), offset);
    text += r.text.split("\n\n").slice(1).join("\n\n");
    offset = Number(m[2]);
  }
  assert.equal(text.length, total);
  assert.match(text, /Emoji final 😀$/);

  const beyond = await mcp.call("zotero_get_note", { note_key: "NOTE0001", offset: total + 10 });
  assert.match(beyond.text, /au-delà de la fin/);
});

test("note : refus d'un élément qui n'est pas une note", async () => {
  const r = await mcp.call("zotero_get_note", { note_key: "BOOK0001" });
  assert.equal(r.isError, true);
  assert.match(r.text, /pas une note \(type : book\)/);
});

test("annotations : toutes lues, triées, dessins seulement comptés", async () => {
  const r = await mcp.call("zotero_annotations", { attachment_key: "ATTACH01" });
  const head = r.text.split("\n")[0];
  assert.match(head, /^240 annotation\(s\) avec texte \| 1-100 \| suite : start=100 \| 10 annotation\(s\) sans texte/);
  const lines = r.text.split("\n").slice(1);
  assert.equal(lines.length, 100);
  assert.equal(lines[0], "[p. 10] (highlight) | texte : texte surligné 0");
  assert.equal(lines[3], "[p. 10] (highlight) | texte : texte surligné 3 | commentaire : mon commentaire");
  const end = await mcp.call("zotero_annotations", { attachment_key: "ATTACH01", start: 200, limit: 200 });
  assert.match(end.text, /^240 annotation\(s\) avec texte \| 201-240 \| fin/);
  assert.match(end.text, /texte surligné 248$/);
});

test("annotations : refus si la clé n'est pas une pièce jointe", async () => {
  const r = await mcp.call("zotero_annotations", { attachment_key: "BOOK0001" });
  assert.equal(r.isError, true);
  assert.match(r.text, /pas une pièce jointe/);
});

test("clés : minuscules acceptées, clés invalides refusées", async () => {
  const ok = await mcp.call("zotero_get_item", { item_key: "book0001" });
  assert.equal(ok.isError, false);
  for (const bad of ["../../et", "ABC/1234", "ABCD%2F12"]) {
    const r = await mcp.call("zotero_get_item", { item_key: bad }).catch((e) => ({ isError: true, text: e.message }));
    assert.equal(r.isError, true, bad);
  }
  const short = await mcp.call("zotero_get_item", { item_key: "../etc" }).catch((e) => ({ isError: true, text: e.message }));
  assert.equal(short.isError, true);
  const unknown = await mcp.call("zotero_get_item", { item_key: "ZZZZZZZZ" });
  assert.match(unknown.text, /introuvable \(404\)/);
});

test("uniquement des GET vers /api/users/0, avec un Host local", () => {
  assert.ok(fake.log.length > 10);
  for (const r of fake.log) {
    assert.equal(r.method, "GET");
    assert.match(r.url, /^\/api\/users\/0\//);
    assert.match(r.host, /^localhost:\d+$/);
  }
});

test("erreur : Zotero fermé", async () => {
  const port = await freePort();
  const m = await connect(port);
  try {
    const r = await m.call("zotero_search", { query: "x" });
    assert.equal(r.isError, true);
    assert.match(r.text, /Zotero est probablement fermé/);
  } finally {
    await m.client.close();
  }
});

test("erreur : option de l'API locale décochée (403)", async () => {
  const f = await startFakeZotero({ mode: "403" });
  const m = await connect(f.port);
  try {
    const r = await m.call("zotero_search", { query: "x" });
    assert.equal(r.isError, true);
    assert.match(r.text, /403.*Allow other applications/);
  } finally {
    await m.client.close();
    await f.close();
  }
});

test("erreur : délai dépassé", async () => {
  const f = await startFakeZotero({ mode: "slow" });
  const m = await connect(f.port, { ZOTERO_TIMEOUT_MS: "1000" });
  try {
    const r = await m.call("zotero_search", { query: "x" });
    assert.equal(r.isError, true);
    assert.match(r.text, /Délai dépassé/);
  } finally {
    await m.client.close();
    await f.close();
  }
});
