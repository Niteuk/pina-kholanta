# 🗿 Pina Kho-lanta

Bot Discord façon Koh-Lanta pour un petit serveur entre amis.
À la fin de chaque session vocale, les joueurs se notent anonymement par catégorie.
Le bot désigne ensuite le **MVP** et le **boulet** du soir, et garde les statistiques de chacun.

## Fonctionnement

1. Quelqu'un rejoint le salon vocal suivi : une **session** s'ouvre.
2. Le bot compte le temps passé en voc par chaque joueur. Les déconnexions et reconnexions s'additionnent.
3. Quand le vocal reste vide **5 min**, la session se termine.
4. Les joueurs qui ont passé au moins **1 h** en voc sont éligibles (il en faut au moins 3).
5. Chaque joueur éligible reçoit en **message privé** un bulletin pour noter les autres de 1 à 5 dans chaque catégorie.
   - Si on ne peut pas juger une catégorie, on met **3 · Pas d'avis / neutre**.
   - Les joueurs désabonnés (`/pkl desabonner`) ne votent pas et ne sont pas notés.
6. **15 min** plus tard, le conseil se termine :
   - le score d'un joueur est la moyenne de ses moyennes par catégorie ;
   - le meilleur score est **MVP**, le pire est **boulet** ;
   - en cas d'égalité, il y a deux MVP (ou deux boulets) ;
   - la révélation se fait avec suspense dans le salon des résultats.
7. Le lendemain, on repart de zéro. Seules les statistiques sont conservées.

## Commandes

| Commande | Rôle |
|---|---|
| `/pkl profil [joueur]` | Sessions, MVP et boulets (nombre et %), moyennes par catégorie |
| `/pkl classement <type>` | Classement MVP, Boulet ou d'une catégorie (avec autocomplétion) |
| `/pkl session` | Session en cours, temps de chacun, vote en cours |
| `/pkl aide` | Règles du jeu et liste des commandes |
| `/pkl desabonner` | Ne plus participer aux conseils (ni bulletin, ni note) |
| `/pkl abonner` | Participer de nouveau aux conseils |
| `/pkl config salon-vocal <salon>` | *(admin)* Salon vocal suivi |
| `/pkl config salon-resultats <salon>` | *(admin)* Salon où sont publiés les résultats |
| `/pkl config voir` | *(admin)* Configuration actuelle |
| `/pkl categorie ajouter / retirer / liste` | *(admin)* Gestion des catégories de notes |
| `/pkl admin forcer-fin` | *(admin)* Termine la session tout de suite et lance le conseil |
| `/pkl admin annuler` | *(admin)* Annule la session ou le vote en cours |

Les commandes admin demandent la permission **Gérer le serveur**.

## 1. Créer le bot sur Discord

1. Va sur <https://discord.com/developers/applications>, puis **New Application** et nomme-la « Pina Kho-lanta ».
2. Dans l'onglet **Bot** :
   - clique sur **Reset Token** et copie le token, c'est ton `DISCORD_TOKEN` (ne le partage jamais) ;
   - mets l'avatar et le nom du bot.
   - Aucun « Privileged Gateway Intent » n'est nécessaire.
3. Dans l'onglet **OAuth2 > URL Generator** :
   - scopes : `bot` et `applications.commands` ;
   - permissions : *View Channels*, *Send Messages*, *Embed Links*.
4. Ouvre l'URL générée et invite le bot sur ton serveur.
5. Dans Discord, active **Paramètres > Avancés > Mode développeur**, puis fais clic droit sur ton serveur > **Copier l'identifiant**. C'est ton `GUILD_ID`.

## 2. Héberger le bot (hébergeur gratuit spécialisé)

La plupart des hébergeurs gratuits de bots ont un panneau du même genre :

1. Crée un serveur ou une application **Node.js** et choisis la **version 22 ou plus récente** si on te le propose.
2. Envoie les fichiers du projet, **sans** `node_modules/` ni `data/`.
3. Renseigne les variables d'environnement `DISCORD_TOKEN` et `GUILD_ID`. Si le panneau ne le permet pas, copie `.env.example` en `.env` et remplis-le.
4. Indique le fichier de démarrage : `src/index.js` (ou la commande `npm start`).
5. Lance le bot. Les dépendances s'installent en général toutes seules (`npm install`).

Le message `🗿 Pina Kho-lanta connecté…` doit apparaître dans la console.

> **Sauvegardes** : toutes les données sont dans `data/pina-kholanta.db`. Télécharge ce fichier de temps en temps depuis le panneau, car un hébergeur gratuit peut perdre tes fichiers.

## 3. Premier lancement sur le serveur

```
/pkl config salon-vocal salon:#ton-vocal
/pkl config salon-resultats salon:#conseil
```

Les catégories par défaut sont Niveau, Humour, Humilité et Gentillesse. Tu peux les modifier avec `/pkl categorie`.

## Tester rapidement

Ajoute ces variables pour ne pas attendre 1 h (il faut quand même 3 comptes en voc) :

```
MIN_PRESENCE_MINUTES=1
EMPTY_GRACE_MINUTES=1
VOTE_DURATION_MINUTES=2
```

Pense à les retirer ensuite.

## En local (optionnel)

```bash
npm install
cp .env.example .env   # puis remplis-le
npm start
```

## Limites connues

- Si le bot redémarre pendant une session, le temps des joueurs déjà en voc est recompté à partir du redémarrage.
- Les joueurs doivent accepter les messages privés venant des membres du serveur pour recevoir leur bulletin. Le bot signale ceux qu'il n'a pas pu joindre.

## Structure

```
src/
├─ index.js            démarrage, événements Discord
├─ config.js           durées et réglages
├─ db.js               base SQLite et requêtes
├─ scoring.js          calcul des scores, MVP et boulet
├─ session.js          suivi du vocal, bulletins, révélation
└─ commands/pkl.js     commande /pkl et ses sous-commandes
```
