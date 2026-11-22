# Zotero (lecture seule) pour Claude

Cette extension permet à Claude de **lire** votre bibliothèque Zotero : références, notes et annotations de PDF. Elle sert par exemple à préparer des fiches de lecture à partir de vos notes.

Elle ne peut **rien modifier** dans Zotero. Elle ne touche pas au dossier Zotero ni au fichier `zotero.sqlite`. Elle ne contacte aucun serveur sur Internet : elle interroge seulement Zotero sur votre propre ordinateur.

## Ce qu'il faut

- L'application **Claude** pour ordinateur (macOS ou Windows). Elle contient déjà tout le nécessaire : vous n'avez rien d'autre à installer.
- **Zotero 7 ou plus récent**, ouvert pendant que vous utilisez Claude.

## 1. Autoriser Claude à interroger Zotero

1. Ouvrez Zotero.
2. Ouvrez les réglages : menu **Zotero > Réglages…** sur Mac, **Édition > Paramètres** sur Windows.
3. Allez dans l'onglet **Avancé**.
4. Cochez **« Allow other applications on this computer to communicate with Zotero »**. Dans Zotero en français, l'intitulé est l'équivalent : autoriser les autres applications de cet ordinateur à communiquer avec Zotero.

Laissez Zotero ouvert : l'extension ne fonctionne que si Zotero tourne.

## 2. Installer l'extension

1. Téléchargez le fichier **`zotero-local-readonly.mcpb`** sur la page [Releases](https://github.com/jomaora/zotero-mcp/releases/latest), dans la partie « Assets ». Le même fichier sert pour macOS et pour Windows.
2. Double-cliquez sur le fichier : l'application Claude propose de l'installer. Sinon, ouvrez Claude, allez dans **Réglages > Extensions** et faites glisser le fichier dans la fenêtre.
3. Confirmez l'installation. L'extension s'appelle **« Zotero (lecture seule) »**.

Les noms exacts des menus peuvent varier selon la version de l'application Claude.

## 3. Premier test

Dans une nouvelle conversation avec Claude, écrivez par exemple :

> Cherche dans ma bibliothèque Zotero le livre de Trigger sur les Hurons, puis liste ses notes.

Claude doit utiliser les outils « Zotero » et vous montrer la référence trouvée, avec sa clé (8 caractères, par exemple `ABCD1234`).

Ensuite, vous pouvez demander :

> Lis la note « Citations du livre » de cette référence.

## Ce que Claude peut faire avec l'extension

| Outil | Rôle |
|---|---|
| `zotero_search` | Chercher une référence par mots du titre, de l'auteur ou l'année |
| `zotero_get_item` | Afficher toutes les informations d'une référence |
| `zotero_children` | Lister les notes et pièces jointes (PDF) d'une référence |
| `zotero_get_note` | Lire une note, par tranches si elle est longue |
| `zotero_annotations` | Lire les surlignages et commentaires d'un PDF |

Dans les notes, l'italique apparaît `_ainsi_`, le gras `**ainsi**` et les titres avec `#`. Les annotations sans texte, comme les dessins à main levée, sont comptées mais pas affichées.

## En cas de problème

| Message de Claude | Que faire |
|---|---|
| « Connexion impossible à Zotero… Zotero est probablement fermé » | Ouvrez Zotero, puis réessayez. |
| « Zotero a refusé la requête (403) » | Cochez l'option de l'étape 1 dans les réglages de Zotero. |
| « Élément introuvable (404) » | La clé n'existe pas : relancez une recherche. |
| « Délai dépassé » | Zotero est occupé (synchronisation, gros import) : réessayez un peu plus tard. |

Si l'installation de l'extension échoue, notez le message exact affiché par Claude.

## Pour les développeurs

Il faut Node.js 20 ou plus récent.

```bash
npm ci
```

```bash
npm test
```

```bash
npm run pack
```

- `npm test` lance les tests contre un faux Zotero (`tests/fake_zotero.mjs`). Ses données sont fictives.
- `npm run pack` vérifie le manifeste et produit `dist/zotero-local-readonly.mcpb`, avec les seules dépendances d'exécution.
- Publier une version : mettre à jour `version` dans `manifest.json`, `package.json` et `server/index.js`, commiter, puis pousser un tag `v<version>` (par exemple `git tag v1.1.0 && git push origin v1.1.0`). Le workflow `release.yml` construit le `.mcpb` et l'attache à une release GitHub.
- Variables d'environnement facultatives : `ZOTERO_LOCAL_PORT` (port de l'API locale, 23119 par défaut) et `ZOTERO_TIMEOUT_MS` (délai par requête, 15 000 ms par défaut).

Garanties du serveur (`server/index.js`) :

- uniquement des requêtes `GET` vers `127.0.0.1:<port>/api/users/0/…` ;
- aucun outil n'accepte d'URL ou de chemin ;
- les clés d'éléments sont validées (`^[A-Z0-9]{8}$`) ;
- aucun accès au dossier Zotero ni à `zotero.sqlite`.

## Licence

MIT, voir [LICENSE](LICENSE).
