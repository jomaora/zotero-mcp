// Construit dist/zotero-local-readonly.mcpb avec les seules dépendances
// d'exécution (sans les outils de développement comme mcpb lui-même).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const stage = path.join(dist, "stage");
const out = path.join(dist, "zotero-local-readonly.mcpb");
// Tout passe par l'exécutable Node courant : pas de shell, pas de souci de
// .cmd ni d'espaces dans les chemins sous Windows.
const node = (args, cwd) => execFileSync(process.execPath, args, { cwd, stdio: "inherit" });
const npmCli = process.env.npm_execpath; // défini par « npm run pack »
if (!npmCli || !npmCli.endsWith(".js")) {
  console.error("Lancer ce script avec : npm run pack");
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const f of ["manifest.json", "package.json", "package-lock.json", ".mcpbignore", "LICENSE"]) {
  fs.copyFileSync(path.join(root, f), path.join(stage, f));
}
fs.cpSync(path.join(root, "server"), path.join(stage, "server"), { recursive: true });

node([npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
const mcpb = path.join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
node([mcpb, "validate", "manifest.json"], stage);
node([mcpb, "pack", stage, out], root);
console.log(`\nExtension prête : ${path.relative(root, out)}`);
