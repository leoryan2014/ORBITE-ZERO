# Orbite Zéro — Serveur temps réel

Serveur WebSocket avec matchmaking par région et anti-triche **autoritaire**
(le serveur, pas le navigateur du joueur, décide si une action est valide).

## Ce que ce serveur fait déjà
- Matchmaking par région + mode (deathmatch, battle royale, party)
- Création automatique de salons de partie
- Relais des mouvements et des tirs entre joueurs
- **Anti-triche réel** : rejette les téléportations, les vitesses
  impossibles, la cadence de tir trop rapide, et les dégâts hors limites
- Suspension automatique après plusieurs signalements

## Ce qu'il ne fait pas encore (à ajouter si besoin)
- Comptes persistants avec mot de passe (actuellement : juste un pseudo)
- Base de données persistante (tout est en mémoire → perdu au redémarrage)
- Simulation physique complète côté serveur (positions "de confiance" côté
  client, seulement validées a posteriori — suffisant contre 95% de la
  triche, pas contre un aimbot très discret)
- Chiffrement/anti-DDoS avancé (un hébergeur sérieux gère une partie de ça)

## 1. Tester en local

```bash
npm install
npm start
```

Le serveur écoute sur `http://localhost:3000`. Vérifie qu'il tourne :
`http://localhost:3000/health`

## 2. Héberger pour de vrai (accessible depuis le monde entier)

Je ne peux pas héberger ce serveur à ta place — il me faut un service qui le
garde allumé en continu. Voici 3 options simples avec un plan gratuit/pas cher :

### Option A — Railway (le plus simple)
1. Crée un compte sur https://railway.app
2. "New Project" → "Deploy from GitHub repo" (mets ce dossier sur GitHub
   d'abord, ou utilise "Empty project" puis leur CLI pour push direct)
3. Railway détecte `package.json` et lance `npm start` automatiquement
4. Il te donne une URL du type `https://ton-projet.up.railway.app`

### Option B — Render
1. Compte sur https://render.com
2. "New Web Service" → connecte ton repo GitHub
3. Build command : `npm install` — Start command : `npm start`
4. URL fournie automatiquement, HTTPS inclus

### Option C — Fly.io
Plus technique mais plus de contrôle (régions multiples, ce qui réduit le
ping pour les joueurs loin de toi) — utile si tu veux vraiment une bonne
expérience "monde entier". Dis-le-moi si tu veux ce chemin, je te fais le
`fly.toml` et les étapes.

**Important :** ces plans gratuits mettent souvent le serveur en veille après
inactivité (le premier joueur attend quelques secondes au réveil). Pour du
24/24 sans coupure il faut un plan payant (~5-7$/mois).

## 3. Connecter ton `index.html` au serveur

Ton jeu utilise actuellement `window.storage` (stockage clé/valeur) pour le
chat, les classements, etc. — ça reste utile et peut cohabiter avec ce
serveur. Ajoute ce module dans ton jeu pour le temps réel :

```html
<script>
const NET = (() => {
  let ws, id, onMsg = {};
  function connect(url, name) {
    ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.t === 'welcome') id = msg.id;
      (onMsg[msg.t] || []).forEach(fn => fn(msg));
    };
  }
  function on(type, fn) { (onMsg[type] ||= []).push(fn); }
  function send(type, data) { ws && ws.readyState === 1 && ws.send(JSON.stringify({ t: type, ...data })); }
  return { connect, on, send, get id(){ return id; } };
})();

// Exemple d'utilisation :
// NET.connect('wss://ton-projet.up.railway.app', P.name);
// NET.on('matchStart', (msg) => { /* démarre ta partie avec msg.players, msg.seed */ });
// NET.send('findMatch', { region: P.region, mode: 'deathmatch' });
// NET.send('move', { pos: { x, y, z } });   // à chaque frame ou toutes les 50-100ms
// NET.send('hit', { targetId, dmg });        // quand ton arme touche quelqu'un
</script>
```

Remplace `wss://ton-projet...` par l'URL réelle une fois déployé (`wss://`
et pas `ws://` car l'hébergeur te donne du HTTPS).

## 4. Étapes suivantes possibles

Dis-moi ce que tu veux en premier, je peux ajouter :
- Vrais comptes (inscription/connexion sécurisée avec mots de passe hashés)
- Base de données persistante (Postgres via Railway/Render, gratuit aussi)
- Simulation de position plus stricte (le serveur calcule le mouvement
  au lieu de seulement le valider — anti-triche encore plus solide)
- Salles privées avec code (pour jouer entre amis uniquement)
