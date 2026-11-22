// Faux Zotero local pour les tests.
//
// Il reproduit les comportements de l'API locale observés sur un vrai Zotero
// (10.0.9, novembre 2026) : écoute sur 127.0.0.1 seulement, 400 si l'en-tête
// Host n'est pas local, 404 en text/plain pour une clé inconnue mais 200 et []
// pour /children d'une clé inconnue, annotations absentes de /children sauf
// avec itemType=annotation, en-tête Total-Results, pas de plafond à 100 sur
// « limit », recherche « q » : tous les mots, dans n'importe quel ordre.
//
// Les données sont fictives (aucune donnée d'une vraie bibliothèque).
import http from "node:http";
import { pathToFileURL } from "node:url";

const longPara = (n) => `<p>Paragraphe ${n} ` + "mot ".repeat(120) + "</p>";
const noteHtml =
  '<div data-schema-version="9"><h1>Citations du livre</h1>' +
  '<p>« Les Hurons &amp; leurs voisins » <em>(note perso : voir p. 12)</em> <strong>important</strong></p>' +
  '<p>Ligne&nbsp;avec&nbsp;nbsp &#233;t&#xE9; &lt;pas une balise&gt; a &lt; b</p><ul><li>un</li><li>deux</li></ul>' +
  '<p><em>a</em><em>b</em> fin<br>ligne suivante</p>' +
  '<p><span style="color: #ff2020">rouge</span> <span class="citation" data-citation="%7B%22a%22%3A%22%3E%22%7D">(Auteur 1991)</span></p>' +
  "<h2>Section</h2>" +
  Array.from({ length: 200 }, (_, i) => longPara(i)).join("") +
  "<p>Emoji final 😀</p></div>";

const item = (key, data, numChildren = 0, extra = {}) => ({
  key,
  version: 1,
  library: { type: "user", id: 0, name: "Ma bibliothèque" },
  meta: { numChildren, ...extra },
  data: { key, version: 1, tags: [], relations: {}, dateAdded: "2026-01-01T00:00:00Z", dateModified: "2026-01-01T00:00:00Z", ...data },
});

const book = item(
  "BOOK0001",
  {
    itemType: "book",
    title: "Les Enfants d'Exemple : histoire d'un peuple fictif",
    shortTitle: "Les Enfants d'Exemple",
    creators: [
      { creatorType: "author", firstName: "Jeanne", lastName: "Auteur" },
      { creatorType: "translator", firstName: "Paul", lastName: "Traducteur" },
    ],
    date: "1991",
    publisher: "Éditions Fictives",
    place: "Montréal",
    numPages: "972",
    collections: ["COLL0001"],
  },
  2,
  { creatorSummary: "Auteur", parsedDate: "1991" },
);
const note = item("NOTE0001", { itemType: "note", parentItem: "BOOK0001", note: noteHtml });
const att = item(
  "ATTACH01",
  { itemType: "attachment", parentItem: "BOOK0001", title: "PDF", linkMode: "linked_file", contentType: "application/pdf", charset: "", path: "/Users/x/secret/fichier.pdf" },
  0, // le vrai Zotero compte 0 enfant : les annotations ne sont pas comptées
);
// 250 annotations : 230 surlignages, 20 dessins ; renvoyées dans le désordre.
const annotations = Array.from({ length: 250 }, (_, i) => {
  const ink = i % 25 === 24;
  return item(`ANN${String(i).padStart(5, "0")}`, {
    itemType: "annotation",
    parentItem: "ATTACH01",
    annotationType: ink ? "ink" : "highlight",
    annotationAuthorName: "",
    annotationText: ink ? "" : `texte surligné ${i}`,
    annotationComment: i === 3 ? "mon commentaire" : "",
    annotationColor: "#ffd400",
    annotationPageLabel: String(10 + Math.floor(i / 5)),
    annotationSortIndex: `${String(Math.floor(i / 5)).padStart(5, "0")}|${String(i).padStart(6, "0")}|00000`,
    annotationPosition: "{}",
  });
}).reverse();
// Référence avec 150 enfants, pour vérifier la pagination au-delà de 100.
const big = item("BIGPAREN", { itemType: "book", title: "Gros dossier", creators: [] }, 150);
const bigChildren = Array.from({ length: 150 }, (_, i) =>
  item(`BIGN${String(i).padStart(4, "0")}`, { itemType: "note", parentItem: "BIGPAREN", note: `<p>note ${i}</p>` }),
);
const standalone = item("STANDNOT", { itemType: "note", note: "<h1>Idées en vrac</h1><p>texte</p>" });

const all = [book, note, att, ...annotations, big, ...bigChildren, standalone];
const byKey = Object.fromEntries(all.map((i) => [i.key, i]));
const top = [book, big, standalone];

export function startFakeZotero({ mode = "ok", port = 0 } = {}) {
  const log = [];
  const srv = http.createServer((req, res) => {
    log.push({ method: req.method, url: req.url, host: req.headers.host });
    const sendJson = (code, obj, total) => {
      const h = { "Content-Type": "application/json", "Zotero-API-Version": "3" };
      if (total !== undefined) h["Total-Results"] = String(total);
      res.writeHead(code, h);
      res.end(JSON.stringify(obj));
    };
    const sendText = (code, t) => {
      res.writeHead(code, { "Content-Type": "text/plain" });
      res.end(t);
    };
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "localhost" && host !== "127.0.0.1") return sendText(400, "Invalid Host header");
    if (req.method !== "GET") return sendText(405, "Method not allowed");
    if (mode === "403") return sendText(403, "Request not allowed");
    if (mode === "slow") return; // ne répond jamais

    const u = new URL(req.url, "http://x");
    const sp = u.searchParams;
    const page = (list) => {
      const start = Number(sp.get("start") ?? 0);
      const limit = Number(sp.get("limit") ?? 25); // pas de plafond, comme le vrai Zotero
      return sendJson(200, list.slice(start, start + limit), list.length);
    };
    const byType = (list) => {
      const t = sp.get("itemType");
      return t ? list.filter((i) => i.data.itemType === t) : list;
    };
    if (!u.pathname.startsWith("/api/users/0/")) return sendText(404, "Not found");
    const p = u.pathname.slice("/api/users/0".length);

    if (p === "/items/top") {
      const words = (sp.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const hay = (i) =>
        [i.data.title, i.data.note, ...(i.data.creators ?? []).map((c) => c.lastName), i.data.date].join(" ").toLowerCase();
      return page(byType(top).filter((i) => words.every((w) => hay(i).includes(w))));
    }
    let m;
    if ((m = p.match(/^\/items\/([A-Z0-9]{8})\/children$/))) {
      const kids = all.filter((i) => i.data.parentItem === m[1]);
      // Sans itemType, le vrai Zotero omet les annotations.
      const visible = sp.get("itemType") ? byType(kids) : kids.filter((i) => i.data.itemType !== "annotation");
      return page(visible);
    }
    if ((m = p.match(/^\/items\/([A-Z0-9]{8})$/))) return byKey[m[1]] ? sendJson(200, byKey[m[1]]) : sendText(404, "Not found");
    sendText(404, "Not found");
  });
  return new Promise((resolve) =>
    srv.listen(port, "127.0.0.1", () =>
      resolve({ port: srv.address().port, log, close: () => new Promise((r) => srv.close(r)) }),
    ),
  );
}

// Lancement manuel : node tests/fake_zotero.mjs <port> [ok|403|slow]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const f = await startFakeZotero({ port: Number(process.argv[2] ?? 23119), mode: process.argv[3] ?? "ok" });
  console.log(`Faux Zotero sur 127.0.0.1:${f.port}`);
}
