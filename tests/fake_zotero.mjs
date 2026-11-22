// Faux Zotero local : imite le format JSON de l'API v3 (reconstitué de mémoire, pas capturé sur un vrai Zotero).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const port = Number(process.argv[2]);
const mode = process.argv[3] ?? "ok"; // ok | 403
const log = [];
const longPara = (n) => `<p>Paragraphe ${n} ` + "mot ".repeat(120) + "</p>";
const noteHtml = '<div data-schema-version="9"><h1>Citations du livre</h1>' +
  '<p>« Les Hurons &amp; leurs voisins » <i>(note perso : voir p. 12)</i> <b>important</b></p>' +
  '<p>Ligne&nbsp;avec&nbsp;nbsp &#233;t&#xE9; &lt;pas une balise&gt;</p><ul><li>un</li><li>deux</li></ul>' +
  '<p><i>a</i><i>b</i> fin</p>' +
  Array.from({ length: 200 }, (_, i) => longPara(i)).join("") + "</div>";
const book = { key: "YPLGMC2X", version: 1, library: { type: "user", id: 0 }, meta: { creatorSummary: "Trigger", parsedDate: "1991", numChildren: 2 },
  data: { key: "YPLGMC2X", itemType: "book", title: "Les Enfants d'Aataentsic: L'Histoire du Peuple Huron", shortTitle: "Les Enfants d'Aataentsic",
    creators: [{ creatorType: "author", firstName: "Bruce", lastName: "Trigger" }, { creatorType: "translator", firstName: "Jean-Paul", lastName: "Sainte-Marie" }],
    date: "1991-00-00 1991", publisher: "Libre Expression", place: "Montréal", language: "eng", numPages: "972", tags: [], relations: {}, collections: [] } };
const note = { key: "943XCP8U", version: 1, data: { key: "943XCP8U", itemType: "note", parentItem: "YPLGMC2X", note: noteHtml } };
const att = { key: "ATTACH01", version: 1, data: { key: "ATTACH01", itemType: "attachment", parentItem: "YPLGMC2X", contentType: "application/pdf", filename: "trigger.pdf", linkMode: "imported_file" } };
const ann = { key: "ANNOT001", version: 1, data: { key: "ANNOT001", itemType: "annotation", parentItem: "ATTACH01", annotationType: "highlight", annotationText: "texte surligné", annotationComment: "mon commentaire", annotationPageLabel: "45" } };
const byKey = { YPLGMC2X: book, "943XCP8U": note, ATTACH01: att, ANNOT001: ann };
const srv = http.createServer((req, res) => {
  log.push({ method: req.method, url: req.url, host: req.headers.host });
  fs.writeFileSync((process.env.ZOTERO_FAKE_LOG ?? path.join(os.tmpdir(), "zotero-fake-requests.json")), JSON.stringify(log, null, 1));
  const u = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (mode === "403") return send(403, {});
  const p = u.pathname.replace("/api/users/0", "");
  if (p === "/items/top") {
    const q = (u.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (book.data.title + " Trigger 1991").toLowerCase();
    return send(200, q.every((w) => hay.includes(w)) ? [book] : []);
  }
  let m;
  if ((m = p.match(/^\/items\/([A-Z0-9]{8})\/children$/))) {
    if (m[1] === "YPLGMC2X") return send(200, [note, att]);
    if (m[1] === "ATTACH01") return send(200, [ann]);
    return send(200, []);
  }
  if ((m = p.match(/^\/items\/([A-Z0-9]{8})$/))) return byKey[m[1]] ? send(200, byKey[m[1]]) : send(404, {});
  send(404, {});
});
srv.listen(port, "127.0.0.1");
