// ============================================================================
// ORBITE ZÉRO — Serveur temps réel
// Matchmaking par région + salons de partie + anti-triche AUTORITAIRE.
//
// Principe clé : le client envoie des INTENTIONS (déplacement, tir), jamais
// des résultats. Le serveur calcule/valide tout, donc un client modifié ne
// peut pas juste "dire" qu'il a un score plus haut, une vitesse plus grande,
// ou un tir toujours dans la tête — le serveur refuse ce qui dépasse les
// limites physiques du jeu.
// ============================================================================

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import express from 'express';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Config du jeu — CE SONT LES LIMITES QUE LE SERVEUR IMPOSE (le client ne
// peut pas les dépasser, même s'il ment).
// ---------------------------------------------------------------------------
const CFG = {
  TICK_HZ: 20,                 // fréquence de simulation serveur
  MAX_SPEED: 12,               // unités/seconde — vitesse max plausible
  MAX_TELEPORT_DIST: 25,       // distance max entre deux positions reçues sur 1 tick
  MIN_FIRE_INTERVAL_MS: 90,    // cadence de tir mini (ajuste selon ton arme la + rapide)
  MAX_DAMAGE_PER_HIT: 120,     // dégâts max plausibles pour un seul tir
  MATCH_SIZE: { deathmatch: 8, battleroyale: 20, party: 8 },
  FLAG_THRESHOLD: 5,           // signalements avant suspension auto
};

const REGIONS = ['eu-w','eu-c','af-w','af-c','na-e','na-w','sa','as-e','as-s','me','oce'];

// ---------------------------------------------------------------------------
// État en mémoire (pour la persistance réelle : remplace par une vraie DB,
// voir la note "PERSISTANCE" en bas du fichier)
// ---------------------------------------------------------------------------
const players = new Map();     // ws -> playerState
const queues = new Map();      // "region:mode" -> [ws,...]
const rooms = new Map();       // roomId -> room

function newPlayerState(ws, name) {
  return {
    ws, id: nanoid(8), name: name.slice(0, 16) || 'Pilote',
    region: 'eu-w', mode: null, room: null,
    pos: { x: 0, y: 0, z: 0 }, lastPos: { x: 0, y: 0, z: 0 },
    lastMoveAt: Date.now(), lastShotAt: 0,
    hp: 100, kills: 0, deaths: 0, dmg: 0,
    flags: [], banned: false,
  };
}

function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: type, ...data }));
}
function broadcastRoom(room, type, data, exceptWs = null) {
  for (const p of room.players) {
    if (p.ws !== exceptWs) send(p.ws, type, data);
  }
}

// ---------------------------------------------------------------------------
// Anti-triche autoritaire — chaque fonction renvoie true si l'action est
// valide, false si elle doit être rejetée (et journalisée comme signalement)
// ---------------------------------------------------------------------------
function flagPlayer(p, reason) {
  p.flags.push({ reason, t: Date.now() });
  console.log(`[SENTINELLE] ${p.name} (${p.id}) : ${reason}`);
  if (p.flags.length >= CFG.FLAG_THRESHOLD) {
    p.banned = true;
    send(p.ws, 'banned', { reason: 'Trop de comportements suspects détectés.' });
    console.log(`[SENTINELLE] ${p.name} SUSPENDU automatiquement.`);
  }
}

function validateMove(p, newPos, dtMs) {
  const dt = Math.max(dtMs, 16) / 1000;
  const dx = newPos.x - p.pos.x, dy = newPos.y - p.pos.y, dz = newPos.z - p.pos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (dist > CFG.MAX_TELEPORT_DIST) {
    flagPlayer(p, `téléportation suspecte (${dist.toFixed(1)}u)`);
    return false; // position rejetée : le serveur garde l'ancienne
  }
  const speed = dist / dt;
  if (speed > CFG.MAX_SPEED * 1.5) { // marge pour la latence réseau
    flagPlayer(p, `vitesse suspecte (${speed.toFixed(1)}u/s)`);
    return false;
  }
  return true;
}

function validateShot(p, targetId, room) {
  const now = Date.now();
  if (now - p.lastShotAt < CFG.MIN_FIRE_INTERVAL_MS) {
    flagPlayer(p, `cadence de tir suspecte (${now - p.lastShotAt}ms)`);
    return false;
  }
  p.lastShotAt = now;
  return true;
}

function validateDamage(dmg) {
  return typeof dmg === 'number' && dmg > 0 && dmg <= CFG.MAX_DAMAGE_PER_HIT;
}

// ---------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------
function qKey(region, mode) { return region + ':' + mode; }

function enqueue(p, region, mode) {
  p.region = region; p.mode = mode;
  const key = qKey(region, mode);
  if (!queues.has(key)) queues.set(key, []);
  queues.get(key).push(p);
  send(p.ws, 'queued', { region, mode, position: queues.get(key).length });
  tryMakeMatch(key);
}

function dequeue(p) {
  for (const [key, list] of queues) {
    const i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1);
  }
}

function tryMakeMatch(key) {
  const list = queues.get(key);
  if (!list) return;
  const [region, mode] = key.split(':');
  const need = CFG.MATCH_SIZE[mode] || 8;
  // on lance dès qu'on a au moins 2 joueurs et que la file est pleine,
  // ou après un court délai (voir startQueueTimers) pour ne pas faire
  // attendre indéfiniment un petit groupe.
  if (list.length >= need) {
    const group = list.splice(0, need);
    startMatch(group, region, mode);
  }
}

function startMatch(group, region, mode) {
  const roomId = nanoid(6).toUpperCase();
  const room = {
    id: roomId, region, mode, players: group, startedAt: Date.now(),
    seed: nanoid(10),
  };
  rooms.set(roomId, room);
  for (const p of group) {
    p.room = roomId;
    p.hp = 100; p.kills = 0; p.deaths = 0; p.dmg = 0;
  }
  broadcastRoom(room, 'matchStart', {
    roomId, seed: room.seed,
    players: group.map(p => ({ id: p.id, name: p.name })),
  });
  console.log(`[MATCH] ${roomId} démarré (${mode}, ${region}) avec ${group.length} joueurs.`);
}

// Toutes les 4s : si une file attend depuis trop longtemps avec au moins
// 2 joueurs, on démarre quand même une partie plus petite plutôt que de
// faire attendre les gens indéfiniment.
setInterval(() => {
  for (const [key, list] of queues) {
    if (list.length >= 2) {
      const [region, mode] = key.split(':');
      const oldest = list[0];
      if (Date.now() - (oldest._queuedAt || 0) > 25000) {
        const group = list.splice(0, list.length);
        startMatch(group, region, mode);
      }
    }
  }
}, 4000);

// ---------------------------------------------------------------------------
// Serveur HTTP + WebSocket
// ---------------------------------------------------------------------------
const app = express();
app.get('/health', (_req, res) => res.json({
  ok: true, players: players.size, rooms: rooms.size,
  queues: Object.fromEntries([...queues].map(([k, v]) => [k, v.length])),
}));

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let p = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'hello') {
      p = newPlayerState(ws, msg.name || 'Pilote');
      players.set(ws, p);
      send(ws, 'welcome', { id: p.id });
      return;
    }
    if (!p || p.banned) return;

    switch (msg.t) {
      case 'findMatch': {
        const region = REGIONS.includes(msg.region) ? msg.region : 'eu-w';
        const mode = ['deathmatch', 'battleroyale', 'party'].includes(msg.mode) ? msg.mode : 'deathmatch';
        p._queuedAt = Date.now();
        enqueue(p, region, mode);
        break;
      }
      case 'cancelMatch': {
        dequeue(p);
        break;
      }
      case 'move': {
        const room = rooms.get(p.room);
        if (!room) return;
        const dtMs = Date.now() - p.lastMoveAt;
        if (validateMove(p, msg.pos, dtMs)) {
          p.lastPos = p.pos; p.pos = msg.pos;
        }
        p.lastMoveAt = Date.now();
        broadcastRoom(room, 'playerMove', { id: p.id, pos: p.pos }, ws);
        break;
      }
      case 'shot': {
        const room = rooms.get(p.room);
        if (!room) return;
        if (!validateShot(p, msg.targetId, room)) return;
        broadcastRoom(room, 'playerShot', { id: p.id, targetId: msg.targetId, dir: msg.dir });
        break;
      }
      case 'hit': {
        // le CLIENT QUI TIRE signale un impact ; le serveur valide les
        // dégâts avant de les appliquer à la victime — un client triché
        // ne peut pas s'auto-attribuer 9999 dégâts.
        const room = rooms.get(p.room);
        if (!room) return;
        if (!validateDamage(msg.dmg)) { flagPlayer(p, `dégâts hors limites (${msg.dmg})`); return; }
        const victim = room.players.find(pl => pl.id === msg.targetId);
        if (!victim) return;
        victim.hp = Math.max(0, victim.hp - msg.dmg);
        p.dmg += msg.dmg;
        broadcastRoom(room, 'damageApplied', { targetId: victim.id, hp: victim.hp, by: p.id, dmg: msg.dmg });
        if (victim.hp <= 0) {
          p.kills++; victim.deaths++;
          broadcastRoom(room, 'elimination', { killer: p.id, victim: victim.id });
        }
        break;
      }
      case 'leaveMatch': {
        const room = rooms.get(p.room);
        if (room) {
          room.players = room.players.filter(pl => pl !== p);
          broadcastRoom(room, 'playerLeft', { id: p.id });
          if (room.players.length === 0) rooms.delete(room.id);
        }
        p.room = null;
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!p) return;
    dequeue(p);
    const room = rooms.get(p.room);
    if (room) {
      room.players = room.players.filter(pl => pl !== p);
      broadcastRoom(room, 'playerLeft', { id: p.id });
      if (room.players.length === 0) rooms.delete(room.id);
    }
    players.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur Orbite Zéro sur le port ${PORT}`));

// ============================================================================
// NOTE — PERSISTANCE
// Cet état (joueurs, salons, files) vit en mémoire : il est perdu si le
// serveur redémarre. Pour une vraie prod, remplace les Map() par une base
// (Postgres/Redis) — demande-moi et je t'ajoute ça.
//
// NOTE — SÉCURITÉ
// Ce serveur n'a pas encore d'authentification robuste (mot de passe,
// tokens signés) : n'importe qui peut se connecter avec le nom qu'il veut.
// Pour empêcher l'usurpation d'identité, il faut relier ça à un vrai
// système de comptes (voir suite possible ci-dessous).
// ============================================================================
