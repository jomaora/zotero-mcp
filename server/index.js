// Serveur MCP Zotero : lecture seule, API locale uniquement.
//
// - Il tourne sur votre ordinateur et ne parle qu'à l'API locale de Zotero
//   (http://127.0.0.1:23119/api/users/0/...), qui ne demande aucune clé.
// - Il n'envoie que des requêtes GET. Aucune écriture, aucune suppression.
// - L'hôte est fixé dans le code : aucun outil n'accepte d'URL. Les clés
//   d'éléments sont validées (8 caractères, majuscules et chiffres).
// - Il n'ouvre ni le dossier Zotero ni zotero.sqlite.
//
// Prérequis côté Zotero (version 7 ou plus) : Zotero ouvert, et l'option
// « Allow other applications on this computer to communicate with Zotero »
// cochée (Réglages > Avancé).
//
// Comportements de l'API locale vérifiés sur un vrai Zotero (10.0.9) :
// - Zotero n'écoute qu'en IPv4 sur 127.0.0.1 ; « localhost » peut se résoudre
//   en ::1 et échouer, d'où l'ordre des hôtes ci-dessous.
// - Un en-tête Host autre que localhost/127.0.0.1 donne un 400.
// - /items/<clé>/children ne renvoie PAS les annotations d'un PDF, sauf avec
//   itemType=annotation.
// - L'API locale ne plafonne pas « limit » à 100 : on pagine avec
//   l'en-tête Total-Results.
// - Une clé inconnue donne 404 sur /items/<clé>, mais 200 et [] sur
//   /items/<clé>/children.

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "1.1.0";
const PORT = parsePort(process.env.ZOTERO_LOCAL_PORT);
const BASE_PATH = "/api/users/0";
// Délai total par requête (15 s par défaut ; ZOTERO_TIMEOUT_MS, entre 1 et 120 s).
const TIMEOUT_MS = Math.min(Math.max(Number(process.env.ZOTERO_TIMEOUT_MS) || 15000, 1000), 120000);
const MAX_BODY_BYTES = 20 * 1024 * 1024; // garde-fou contre une réponse démesurée
const PAGE_SIZE = 100;
const MAX_CHILDREN = 1000;
const KEY_RE = /^[A-Z0-9]{8}$/;
const ITEM_TYPE_RE = /^[A-Za-z |-]{1,80}$/;
const HOSTS = ["127.0.0.1", "localhost"];
// Agent dédié : il ignore toute configuration de proxy globale (NODE_USE_ENV_PROXY, etc.).
const AGENT = new http.Agent({ keepAlive: false });

class ZoteroError extends Error {}

function parsePort(v) {
  if (v === undefined || v === "") return 23119;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    process.stderr.write(`ZOTERO_LOCAL_PORT invalide (${v}) : port 23119 utilisé.\n`);
    return 23119;
  }
  return n;
}

// ---------------------------------------------------------------- HTTP (GET)

function getOnce(host, path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = http.request(
      {
        host,
        port: PORT,
        path,
        method: "GET",
        agent: AGENT,
        headers: {
          Host: `localhost:${PORT}`,
          "Zotero-API-Version": "3",
          Accept: "application/json",
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy();
            done(reject, Object.assign(new Error("too large"), { code: "ETOOLARGE" }));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          done(resolve, {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", (e) => done(reject, e));
        res.on("aborted", () => done(reject, Object.assign(new Error("aborted"), { code: "ECONNRESET" })));
      },
    );
    // Délai total (connexion + réponse complète), pas seulement d'inactivité.
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    }, TIMEOUT_MS);
    req.on("error", (e) => done(reject, e));
    req.end();
  });
}

async function zgetRaw(path, params = {}) {
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
      // On ne réessaie l'autre adresse que si la connexion a été refusée.
      if (e.code !== "ECONNREFUSED" && e.code !== "EADDRNOTAVAIL" && e.code !== "ENOTFOUND") break;
    }
  }
  if (!res) {
    if (lastErr?.code === "ETIMEDOUT") {
      throw new ZoteroError(`Délai dépassé (${TIMEOUT_MS / 1000} s) en interrogeant Zotero sur le port ${PORT}.`);
    }
    if (lastErr?.code === "ETOOLARGE") {
      throw new ZoteroError("Réponse de Zotero trop volumineuse : requête abandonnée.");
    }
    if (lastErr?.code === "ECONNRESET") {
      throw new ZoteroError("Zotero a interrompu la connexion. Réessayez.");
    }
    throw new ZoteroError(
      `Connexion impossible à Zotero (port ${PORT}). Zotero est probablement fermé : ouvrez-le et réessayez.`,
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
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new ZoteroError("Réponse inattendue de Zotero (JSON invalide).");
  }
  const total = Number.parseInt(res.headers["total-results"] ?? "", 10);
  return { json, total: Number.isFinite(total) ? total : undefined };
}

async function zget(path, params = {}) {
  return (await zgetRaw(path, params)).json;
}

// Récupère une liste paginée (au plus `max` éléments).
async function zgetAll(path, params = {}, max = MAX_CHILDREN) {
  const out = [];
  let total;
  for (let start = 0; out.length < max; start += PAGE_SIZE) {
    const r = await zgetRaw(path, { ...params, limit: Math.min(PAGE_SIZE, max - out.length), start });
    if (!Array.isArray(r.json)) throw new ZoteroError("Réponse inattendue de Zotero (liste attendue).");
    total = r.total;
    out.push(...r.json);
    if (r.json.length === 0 || (total !== undefined && out.length >= total)) break;
    if (total === undefined && r.json.length < PAGE_SIZE) break;
  }
  return { items: out, total: total ?? out.length };
}

// ------------------------------------------------------------------ Helpers

function checkKey(key) {
  const k = String(key ?? "").trim().toUpperCase();
  if (!KEY_RE.test(k)) {
    throw new ZoteroError("Clé invalide : elle doit comporter 8 caractères (majuscules et chiffres).");
  }
  return k;
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»",
  hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const k = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, k) ? NAMED_ENTITIES[k] : m;
  });
}

// Une balise HTML, en tolérant « > » dans les valeurs d'attribut entre guillemets.
const TAG = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const re = (src, flags = "gi") => new RegExp(src.replaceAll("@", TAG), flags);

// HTML d'une note Zotero -> texte. Italiques rendus _ainsi_, gras **ainsi**,
// titres en « # », pour distinguer les commentaires personnels (souvent en
// italique) et la structure de la note.
function htmlToText(html) {
  let s = String(html ?? "");
  s = s.replace(re("<(script|style)\\b@>[\\s\\S]*?</\\1\\s*>"), "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Italiques / gras adjacents fusionnés (<i>a</i><i>b</i> -> _ab_).
  s = s.replace(re("</(i|em)>\\s*<(i|em)\\b@>"), "").replace(re("</(b|strong)>\\s*<(b|strong)\\b@>"), "");
  s = s.replace(re("<(i|em)\\b@>"), "_").replace(/<\/(i|em)\s*>/gi, "_");
  s = s.replace(re("<(b|strong)\\b@>"), "**").replace(/<\/(b|strong)\s*>/gi, "**");
  s = s.replace(re("<h([1-6])\\b@>"), (_, n) => `\n${"#".repeat(Number(n))} `);
  s = s.replace(re("<br\\b@>"), "\n");
  s = s.replace(re("<li\\b@>"), "\n- ");
  s = s.replace(re("<(td|th)\\b@>"), " | ");
  s = s.replace(/<\/(p|div|blockquote|h[1-6]|pre|tr|ul|ol|table)\s*>/gi, "\n");
  s = s.replace(re("<(p|div|blockquote|pre|tr|table)\\b@>"), "\n");
  s = s.replace(re("<[a-zA-Z/!?]@>"), "");
  s = decodeEntities(s);
  s = s.replace(/ /g, " ");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// Découpe sans couper une paire de substitution UTF-16 (emoji, etc.).
function safeSlice(t, start, end) {
  const isHigh = (i) => i > 0 && i < t.length && /[\uD800-\uDBFF]/.test(t[i - 1]) && /[\uDC00-\uDFFF]/.test(t[i]);
  if (isHigh(start)) start -= 1;
  if (isHigh(end)) end -= 1;
  return [start, end];
}

function creators(data) {
  return (data.creators ?? [])
    .map((c) => {
      const name = c.name ?? [c.lastName, c.firstName].filter(Boolean).join(", ");
      return c.creatorType ? `${name} (${c.creatorType})` : name;
    })
    .join("; ");
}

function noteTitle(d) {
  const t = htmlToText(d.note).replace(/^#+\s*/, "");
  return t ? t.split("\n")[0].slice(0, 80) : "(note vide)";
}

function oneLine(item) {
  const d = item.data ?? {};
  const meta = item.meta ?? {};
  const parts = [`clé ${item.key ?? "?"}`, d.itemType ?? "?"];
  const title = d.itemType === "note" ? noteTitle(d) : d.title || d.shortTitle || "(sans titre)";
  parts.push(`« ${title} »`);
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

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// -------------------------------------------------------------------- Outils

const server = new McpServer({ name: "zotero-local-readonly", version: VERSION });

server.registerTool(
  "zotero_search",
  {
    title: "Rechercher dans Zotero",
    description:
      "Recherche rapide dans la bibliothèque Zotero locale (éléments de premier niveau). " +
      "query : mots du titre, de l'auteur et/ou l'année, par exemple « Trigger Aataentsic » ; " +
      "tous les mots doivent être présents, dans n'importe quel ordre. " +
      "Il n'existe pas de recherche par champ : vérifier le résultat. " +
      "qmode : « titleCreatorYear » (défaut) ou « everything » (cherche aussi dans les autres champs et le texte intégral indexé). " +
      "item_type : filtre facultatif, par exemple « book » ou « journalArticle » (un type inconnu ne renvoie aucun résultat).",
    inputSchema: {
      query: z.string().min(1).max(200),
      qmode: z.enum(["titleCreatorYear", "everything"]).default("titleCreatorYear"),
      item_type: z.string().max(80).default(""),
      limit: z.number().int().min(1).max(50).default(10),
    },
    annotations: READ_ONLY,
  },
  wrap(async ({ query, qmode = "titleCreatorYear", item_type = "", limit = 10 }) => {
    if (item_type && !ITEM_TYPE_RE.test(item_type)) throw new ZoteroError("item_type invalide.");
    const { json: items, total } = await zgetRaw("/items/top", { q: query, qmode, itemType: item_type, limit, format: "json" });
    if (!Array.isArray(items) || items.length === 0) {
      return "Aucun résultat. Essayez moins de mots, ou qmode=everything.";
    }
    const head =
      total !== undefined && total > items.length
        ? `${items.length} résultat(s) affiché(s) sur ${total} (affiner la recherche ou augmenter limit) :`
        : `${items.length} résultat(s) :`;
    return `${head}\n` + items.map(oneLine).join("\n");
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
    annotations: READ_ONLY,
  },
  wrap(async ({ item_key }) => {
    const key = checkKey(item_key);
    const item = await zget(`/items/${key}`, { format: "json" });
    const d = item.data ?? {};
    if (d.itemType === "note") return "Cet élément est une note : utilisez zotero_get_note.";
    const lines = [`clé : ${item.key}`, `type : ${d.itemType}`];
    const cr = creators(d);
    if (cr) lines.push(`auteurs : ${cr}`);
    // « path » : chemin local d'un fichier lié, inutile à l'agent.
    const skip = new Set(["key", "version", "itemType", "creators", "tags", "relations", "collections", "dateAdded", "dateModified", "path", "annotationPosition"]);
    for (const [k, v] of Object.entries(d)) {
      if (skip.has(k) || v === "" || v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (k === "note") {
        lines.push(`note : ${htmlToText(v)}`);
        continue;
      }
      lines.push(`${k} : ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
    if (Array.isArray(d.tags) && d.tags.length) lines.push(`marqueurs : ${d.tags.map((t) => t.tag).join("; ")}`);
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
    annotations: READ_ONLY,
  },
  wrap(async ({ item_key }) => {
    const key = checkKey(item_key);
    // Vérifie que l'élément existe : /children renvoie [] pour une clé inconnue.
    await zget(`/items/${key}`, { format: "json" });
    const { items: children, total } = await zgetAll(`/items/${key}/children`, { format: "json" });
    if (children.length === 0) {
      return "Aucun élément enfant (ni note, ni pièce jointe).";
    }
    const notes = [];
    const attachments = [];
    const others = [];
    for (const c of children) {
      const d = c.data ?? {};
      if (d.itemType === "note") {
        notes.push(`  clé ${c.key} | ${htmlToText(d.note).length} caractères | début : ${noteTitle(d)}`);
      } else if (d.itemType === "attachment") {
        attachments.push(
          `  clé ${c.key} | ${d.contentType || "?"} | ${d.filename || d.title || "(sans nom)"} | ${d.linkMode ?? "?"}`,
        );
      } else {
        others.push(`  clé ${c.key} | ${d.itemType}`);
      }
    }
    const out = [];
    if (notes.length) out.push(`Notes (${notes.length}) :\n${notes.join("\n")}`);
    if (attachments.length) out.push(`Pièces jointes (${attachments.length}) :\n${attachments.join("\n")}`);
    if (others.length) out.push(`Autres (${others.length}) :\n${others.join("\n")}`);
    if (total > children.length) out.push(`Attention : ${children.length} enfants affichés sur ${total}.`);
    return out.join("\n\n");
  }),
);

server.registerTool(
  "zotero_get_note",
  {
    title: "Lire une note",
    description:
      "Lit le texte d'une note Zotero (clé obtenue avec zotero_children ou zotero_search). Les italiques sont rendus _ainsi_, le gras **ainsi**, les titres avec #. " +
      "Pour une note longue, la lecture se fait par tranches : l'en-tête indique le décalage (offset) à utiliser pour la suite.",
    inputSchema: {
      note_key: z.string().length(8),
      offset: z.number().int().min(0).default(0),
      max_chars: z.number().int().min(1000).max(50000).default(20000),
    },
    annotations: READ_ONLY,
  },
  wrap(async ({ note_key, offset = 0, max_chars = 20000 }) => {
    const key = checkKey(note_key);
    const item = await zget(`/items/${key}`, { format: "json" });
    const d = item.data ?? {};
    if (d.itemType !== "note") {
      throw new ZoteroError(`Cet élément n'est pas une note (type : ${d.itemType ?? "?"}).`);
    }
    const t = htmlToText(d.note);
    if (offset >= t.length && t.length > 0) {
      return `Note ${key} | ${t.length} caractères | offset ${offset} au-delà de la fin de la note.`;
    }
    const [start, end] = safeSlice(t, offset, Math.min(offset + max_chars, t.length));
    const chunk = t.slice(start, end);
    let header = `Note ${key} | ${t.length} caractères | tranche ${start}-${end}`;
    header += end < t.length ? ` | suite : offset=${end}` : " | fin de la note";
    return `${header}\n\n${chunk}`;
  }),
);

server.registerTool(
  "zotero_annotations",
  {
    title: "Annotations d'un PDF",
    description:
      "Liste les annotations (surlignages, commentaires) d'une pièce jointe PDF, dans l'ordre du document. " +
      "La clé est celle d'une pièce jointe, obtenue avec zotero_children. " +
      "Pour un PDF très annoté, la lecture se fait par tranches : l'en-tête indique le « start » à utiliser pour la suite.",
    inputSchema: {
      attachment_key: z.string().length(8),
      start: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    },
    annotations: READ_ONLY,
  },
  wrap(async ({ attachment_key, start = 0, limit = 100 }) => {
    const key = checkKey(attachment_key);
    const att = await zget(`/items/${key}`, { format: "json" });
    const type = att.data?.itemType;
    if (type !== "attachment") {
      throw new ZoteroError(
        `Cet élément n'est pas une pièce jointe (type : ${type ?? "?"}). Utilisez zotero_children pour trouver la clé du PDF.`,
      );
    }
    // Sans itemType=annotation, l'API locale ne renvoie pas les annotations.
    const { items, total } = await zgetAll(`/items/${key}/children`, { format: "json", itemType: "annotation" }, 5000);
    const all = items.filter((c) => c.data?.itemType === "annotation");
    if (all.length === 0) return "Aucune annotation pour cette pièce jointe.";
    // Les annotations sans texte ni commentaire (dessins « ink », images) sont seulement comptées.
    const anns = all.filter((a) => a.data.annotationText || a.data.annotationComment);
    const silent = all.length - anns.length;
    const silentNote = silent ? ` | ${silent} annotation(s) sans texte (dessin, image) non affichée(s)` : "";
    if (anns.length === 0) return `Aucune annotation avec du texte${silentNote}.`;
    // annotationSortIndex (« 00012|001234|00567 ») se trie en ordre lexical simple.
    const idx = (a) => String(a.data.annotationSortIndex ?? "");
    anns.sort((a, b) => (idx(a) < idx(b) ? -1 : idx(a) > idx(b) ? 1 : 0));
    const page = anns.slice(start, start + limit);
    if (page.length === 0) return `${anns.length} annotation(s) ; start=${start} est au-delà de la fin.`;
    const lines = page.map((a) => {
      const d = a.data;
      const parts = [`[p. ${d.annotationPageLabel || "?"}] (${d.annotationType ?? "?"})`];
      if (d.annotationText) parts.push(`texte : ${d.annotationText}`);
      if (d.annotationComment) parts.push(`commentaire : ${d.annotationComment}`);
      return parts.join(" | ");
    });
    const end = start + page.length;
    let head = `${anns.length} annotation(s) avec texte | ${start + 1}-${end}`;
    head += end < anns.length ? ` | suite : start=${end}` : " | fin";
    head += silentNote;
    if (total > items.length) head += ` | attention : ${items.length} lues sur ${total}`;
    return `${head}\n${lines.join("\n")}`;
  }),
);

await server.connect(new StdioServerTransport());
