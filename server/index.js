// Serveur MCP Zotero : lecture seule, API locale uniquement.
//
// - Il tourne sur votre ordinateur et ne parle qu'à l'API locale de Zotero
//   (http://localhost:23119/api/users/0/...), qui ne demande aucune clé.
// - Il n'envoie que des requêtes GET. Aucune écriture, aucune suppression.
// - L'hôte est fixé dans le code : aucun outil n'accepte d'URL. Les clés
//   d'éléments sont validées (8 caractères, majuscules et chiffres).
// - Il n'ouvre ni le dossier Zotero ni zotero.sqlite.
//
// Prérequis côté Zotero (version 7 ou plus) : Zotero ouvert, et l'option
// « Allow other applications on this computer to communicate with Zotero »
// cochée (Réglages > Avancé).

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PORT = Number.parseInt(process.env.ZOTERO_LOCAL_PORT ?? "23119", 10);
const BASE_PATH = "/api/users/0";
const TIMEOUT_MS = 15000;
const KEY_RE = /^[A-Z0-9]{8}$/;
const ITEM_TYPE_RE = /^[A-Za-z |-]{1,80}$/;
const HOSTS = ["localhost", "127.0.0.1"];

class ZoteroError extends Error {}

// ---------------------------------------------------------------- HTTP (GET)

function getOnce(host, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port: PORT,
        path,
        method: "GET",
        headers: {
          Host: `localhost:${PORT}`,
          "Zotero-API-Version": "3",
          Accept: "application/json",
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

async function zget(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const full = BASE_PATH + path + (qs.toString() ? `?${qs}` : "");

  let res;
  let lastErr;
  for (const host of HOSTS) {
    try {
      res = await getOnce(host, full);
      break;
    } catch (e) {
      lastErr = e;
      if (e.code === "ETIMEDOUT") break;
    }
  }
  if (!res) {
    if (lastErr?.code === "ETIMEDOUT") {
      throw new ZoteroError(`Délai dépassé en interrogeant localhost:${PORT}.`);
    }
    throw new ZoteroError(
      `Connexion impossible à localhost:${PORT}. Zotero est probablement fermé, ou l'API locale est désactivée.`,
    );
  }
  if (res.status === 403) {
    throw new ZoteroError(
      "Zotero a refusé la requête (403). Vérifiez que l'option « Allow other applications on this computer to communicate with Zotero » est cochée (Réglages > Avancé).",
    );
  }
  if (res.status === 404) throw new ZoteroError("Élément introuvable (404). Vérifiez la clé.");
  if (res.status < 200 || res.status >= 300) {
    throw new ZoteroError(`Erreur HTTP ${res.status} de l'API locale de Zotero.`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new ZoteroError("Réponse inattendue de Zotero (JSON invalide).");
  }
}

// ------------------------------------------------------------------ Helpers

function checkKey(key) {
  const k = String(key ?? "").trim().toUpperCase();
  if (!KEY_RE.test(k)) {
    throw new ZoteroError("Clé invalide : elle doit comporter 8 caractères (majuscules et chiffres).");
  }
  return k;
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»" };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return Object.prototype.hasOwnProperty.call(named, e.toLowerCase()) ? named[e.toLowerCase()] : m;
  });
}

// HTML d'une note Zotero -> texte. Italiques rendus _ainsi_, gras **ainsi**,
// pour distinguer les commentaires personnels (souvent en italique).
function htmlToText(html) {
  let s = String(html ?? "");
  s = s.replace(/<\/(i|em)><(i|em)\b[^>]*>/gi, "").replace(/<\/(b|strong)><(b|strong)\b[^>]*>/gi, "");
  s = s.replace(/<(i|em)\b[^>]*>/gi, "_").replace(/<\/(i|em)>/gi, "_");
  s = s.replace(/<(b|strong)\b[^>]*>/gi, "**").replace(/<\/(b|strong)>/gi, "**");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(p|div|blockquote|h[1-6]|pre|tr|ul|ol)>/gi, "\n");
  s = s.replace(/<(p|div|blockquote|h[1-6]|pre|tr)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function creators(data) {
  return (data.creators ?? [])
    .map((c) => {
      const name = c.name ?? [c.lastName, c.firstName].filter(Boolean).join(", ");
      return c.creatorType ? `${name} (${c.creatorType})` : name;
    })
    .join("; ");
}

function oneLine(item) {
  const d = item.data ?? {};
  const meta = item.meta ?? {};
  const parts = [`clé ${item.key ?? "?"}`, d.itemType ?? "?"];
  parts.push(`« ${d.title || d.shortTitle || "(sans titre)"} »`);
  const cr = creators(d);
  if (cr) parts.push(cr);
  if (d.date) parts.push(`date : ${d.date}`);
  const where = d.publicationTitle || d.bookTitle || d.publisher;
  if (where) parts.push(where);
  if (meta.numChildren !== undefined) parts.push(`${meta.numChildren} élément(s) enfant(s)`);
  return parts.join(" | ");
}

const text = (t) => ({ content: [{ type: "text", text: t }] });

// Enveloppe : les ZoteroError deviennent des réponses d'erreur lisibles.
const wrap = (fn) => async (args) => {
  try {
    return text(await fn(args));
  } catch (e) {
    if (e instanceof ZoteroError) return { isError: true, content: [{ type: "text", text: e.message }] };
    return { isError: true, content: [{ type: "text", text: `Erreur inattendue : ${e?.message ?? e}` }] };
  }
};

// -------------------------------------------------------------------- Outils

const server = new McpServer({ name: "zotero-local-readonly", version: "1.0.0" });

server.registerTool(
  "zotero_search",
  {
    title: "Rechercher dans Zotero",
    description:
      "Recherche rapide dans la bibliothèque Zotero locale (éléments de premier niveau). " +
      "query : mots du titre et/ou de l'auteur, par exemple « Trigger Aataentsic ». Éviter les apostrophes. " +
      "Il n'existe pas de recherche par champ : vérifier le résultat. " +
      "qmode : « titleCreatorYear » (défaut) ou « everything » (plus de champs). " +
      "item_type : filtre facultatif, par exemple « book » ou « journalArticle ».",
    inputSchema: {
      query: z.string().min(1).max(200),
      qmode: z.enum(["titleCreatorYear", "everything"]).default("titleCreatorYear"),
      item_type: z.string().max(80).default(""),
      limit: z.number().int().min(1).max(50).default(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  wrap(async ({ query, qmode = "titleCreatorYear", item_type = "", limit = 10 }) => {
    if (item_type && !ITEM_TYPE_RE.test(item_type)) throw new ZoteroError("item_type invalide.");
    const items = await zget("/items/top", { q: query, qmode, itemType: item_type, limit, format: "json" });
    if (!Array.isArray(items) || items.length === 0) {
      return "Aucun résultat. Essayez moins de mots, ou qmode=everything.";
    }
    return `${items.length} résultat(s) :\n` + items.map(oneLine).join("\n");
  }),
);

server.registerTool(
  "zotero_get_item",
  {
    title: "Métadonnées d'une référence",
    description:
      "Renvoie les métadonnées complètes d'un élément (auteurs, titre, date, éditeur, etc.). " +
      "Pour une note, utiliser zotero_get_note.",
    inputSchema: { item_key: z.string().length(8) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  wrap(async ({ item_key }) => {
    const key = checkKey(item_key);
    const item = await zget(`/items/${key}`, { format: "json" });
    const d = item.data ?? {};
    if (d.itemType === "note") return "Cet élément est une note : utilisez zotero_get_note.";
    const lines = [`clé : ${item.key}`, `type : ${d.itemType}`];
    const cr = creators(d);
    if (cr) lines.push(`auteurs : ${cr}`);
    const skip = new Set(["key", "version", "itemType", "creators", "tags", "relations", "collections", "dateAdded", "dateModified"]);
    for (const [k, v] of Object.entries(d)) {
      if (skip.has(k) || v === "" || v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      lines.push(`${k} : ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
    if (item.meta?.numChildren !== undefined) lines.push(`éléments enfants : ${item.meta.numChildren}`);
    return lines.join("\n");
  }),
);

server.registerTool(
  "zotero_children",
  {
    title: "Notes et pièces jointes d'une référence",
    description:
      "Liste les éléments enfants d'une référence : notes et pièces jointes (PDF, etc.), avec leur clé. " +
      "Les notes se lisent avec zotero_get_note ; les annotations d'un PDF avec zotero_annotations (clé de la pièce jointe).",
    inputSchema: { item_key: z.string().length(8) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  wrap(async ({ item_key }) => {
    const key = checkKey(item_key);
    const children = await zget(`/items/${key}/children`, { format: "json", limit: 100 });
    if (!Array.isArray(children) || children.length === 0) {
      return "Aucun élément enfant (ni note, ni pièce jointe).";
    }
    const notes = [];
    const attachments = [];
    const others = [];
    for (const c of children) {
      const d = c.data ?? {};
      if (d.itemType === "note") {
        const t = htmlToText(d.note);
        const first = t ? t.split("\n")[0] : "(note vide)";
        notes.push(`  clé ${c.key} | ${t.length} caractères | début : ${first.slice(0, 80)}`);
      } else if (d.itemType === "attachment") {
        attachments.push(
          `  clé ${c.key} | ${d.contentType ?? "?"} | ${d.filename || d.title || "(sans nom)"} | ${d.linkMode ?? "?"}`,
        );
      } else {
        others.push(`  clé ${c.key} | ${d.itemType}`);
      }
    }
    const out = [];
    if (notes.length) out.push(`Notes (${notes.length}) :\n${notes.join("\n")}`);
    if (attachments.length) out.push(`Pièces jointes (${attachments.length}) :\n${attachments.join("\n")}`);
    if (others.length) out.push(`Autres (${others.length}) :\n${others.join("\n")}`);
    if (children.length >= 100) out.push("Attention : 100 enfants renvoyés, la liste est peut-être tronquée.");
    return out.join("\n\n");
  }),
);

server.registerTool(
  "zotero_get_note",
  {
    title: "Lire une note",
    description:
      "Lit le texte d'une note Zotero (clé obtenue avec zotero_children). Les italiques sont rendus _ainsi_ et le gras **ainsi**. " +
      "Pour une note longue, la lecture se fait par tranches : l'en-tête indique le décalage (offset) à utiliser pour la suite.",
    inputSchema: {
      note_key: z.string().length(8),
      offset: z.number().int().min(0).default(0),
      max_chars: z.number().int().min(1000).max(50000).default(20000),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  wrap(async ({ note_key, offset = 0, max_chars = 20000 }) => {
    const key = checkKey(note_key);
    const item = await zget(`/items/${key}`, { format: "json" });
    const d = item.data ?? {};
    if (d.itemType !== "note") throw new ZoteroError("Cet élément n'est pas une note.");
    const t = htmlToText(d.note);
    const chunk = t.slice(offset, offset + max_chars);
    const end = offset + chunk.length;
    let header = `Note ${key} | ${t.length} caractères | tranche ${offset}-${end}`;
    header += end < t.length ? ` | suite : offset=${end}` : " | fin de la note";
    return `${header}\n\n${chunk}`;
  }),
);

server.registerTool(
  "zotero_annotations",
  {
    title: "Annotations d'un PDF",
    description:
      "Liste les annotations (surlignages, commentaires) d'une pièce jointe PDF. La clé est celle d'une pièce jointe, obtenue avec zotero_children.",
    inputSchema: { attachment_key: z.string().length(8) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  wrap(async ({ attachment_key }) => {
    const key = checkKey(attachment_key);
    const children = await zget(`/items/${key}/children`, { format: "json", limit: 100 });
    const anns = (Array.isArray(children) ? children : []).filter((c) => c.data?.itemType === "annotation");
    if (anns.length === 0) return "Aucune annotation pour cette pièce jointe.";
    const lines = anns.map((a) => {
      const d = a.data;
      return `[p. ${d.annotationPageLabel || "?"}] (${d.annotationType ?? "?"}) texte : ${d.annotationText || "-"} | commentaire : ${d.annotationComment || "-"}`;
    });
    const warn = children.length >= 100 ? "\nAttention : 100 éléments renvoyés, la liste est peut-être tronquée." : "";
    return `${anns.length} annotation(s) :\n${lines.join("\n")}${warn}`;
  }),
);

await server.connect(new StdioServerTransport());
