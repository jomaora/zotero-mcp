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
const win = process.platform === "win32";
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: win });

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const f of ["manifest.json", "package.json", "package-lock.json", ".mcpbignore", "LICENSE"]) {
  fs.copyFileSync(path.join(root, f), path.join(stage, f));
}
fs.cpSync(path.join(root, "server"), path.join(stage, "server"), { recursive: true });

run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
const mcpb = path.join(root, "node_modules", ".bin", win ? "mcpb.cmd" : "mcpb");
run(mcpb, ["validate", "manifest.json"], stage);
run(mcpb, ["pack", stage, out], root);
console.log(`\nExtension prête : ${path.relative(root, out)}`);
