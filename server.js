const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

process.on('uncaughtException', function (err) {
  console.error('UNCAUGHT:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', function (err) {
  console.error('UNHANDLED:', err && err.stack ? err.stack : err);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const MAP_W = 1280;
const MAP_H = 960;
const ADMIN_PASS = process.env.ADMIN_PASS || 'peniontale';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const players = new Map();
const STATE_FILE = path.join(__dirname, 'world-state.json');
const MAX_SIGNS = 40;
const MAX_NPCS = 20;
const MAX_PHOTOS = 15;
const MAX_LOG = 60;
const MAX_PHOTO_BYTES = 180000;
const MAX_ACTIONS_PER_VISITOR = 80;

let world = {
  isNight: false,
  collectedStars: Object.create(null),
  signs: [],
  customNpcs: [],
  photos: [],
  adminLog: [],
  visitors: {}
};

function loadWorld() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    world.isNight = !!saved.isNight;
    world.collectedStars = saved.collectedStars || Object.create(null);
    world.signs = Array.isArray(saved.signs) ? saved.signs : [];
    world.customNpcs = Array.isArray(saved.customNpcs) ? saved.customNpcs : [];
    world.photos = Array.isArray(saved.photos) ? saved.photos : [];
    world.adminLog = Array.isArray(saved.adminLog) ? saved.adminLog : [];
    world.visitors = (saved.visitors && typeof saved.visitors === 'object') ? saved.visitors : {};
  } catch (e) {}
}

let saveTimer = null;
function saveWorld() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(world)); }
    catch (e) { console.error('world-state write failed:', e.message); }
  }, 250);
}
loadWorld();

app.use(express.static(path.join(__dirname)));

function resolveHtmlFile() {
  const candidates = [
    process.env.HTML_FILE,
    'Peniontale_Multiplayer-17.html',
    'Peniontale_Multiplayer-15.html',
    'Peniontale_Multiplayer.html',
    'index.html'
  ].filter(Boolean);
  for (let i = 0; i < candidates.length; i++) {
    const full = path.join(__dirname, candidates[i]);
    if (fs.existsSync(full)) return full;
  }
  try {
    const files = fs.readdirSync(__dirname);
    for (let i = 0; i < files.length; i++) {
      if (/peniontale.*\.html$/i.test(files[i]) || /multiplayer.*\.html$/i.test(files[i])) {
        return path.join(__dirname, files[i]);
      }
    }
  } catch (e) {}
  return path.join(__dirname, 'Peniontale_Multiplayer.html');
}

const HTML_PATH = resolveHtmlFile();
console.log('HTML file:', HTML_PATH);

app.get('/', function (req, res) {
  if (!fs.existsSync(HTML_PATH)) {
    res.status(500).send('HTML not found in repo root.');
    return;
  }
  res.sendFile(HTML_PATH);
});

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number(v) || 0));
}
function cleanName(v) {
  const n = String(v || 'Oyuncu').replace(/[<>]/g, '').trim().slice(0, 18);
  return n || 'Oyuncu';
}
function cleanText(v, maxLen) {
  return String(v || '').replace(/[<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, x: p.x, y: p.y, facing: p.facing };
}
function broadcastPlayers() {
  io.emit('world:players', Array.from(players.values()).map(publicPlayer));
}

function addSign(text, x, y) {
  const sign = {
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: cleanText(text, 140) || '(bos ilan)',
    x: clamp(x, 60, MAP_W - 60),
    y: clamp(y, 60, MAP_H - 60),
    ts: Date.now()
  };
  world.signs.push(sign);
  if (world.signs.length > MAX_SIGNS) world.signs.shift();
  saveWorld();
  io.emit('world:sign', sign);
  return sign;
}
function clearSigns() {
  world.signs = [];
  saveWorld();
  io.emit('world:signsCleared');
}

function addCustomNpc(data) {
  const name = cleanText(data.name || 'Yeni', 24) || 'Yeni';
  let lines = Array.isArray(data.lines)
    ? data.lines.map(function (l) { return cleanText(l, 120); }).filter(Boolean).slice(0, 6)
    : [];
  if (!lines.length) lines.push(name + ' burada.');
  const letter = cleanText(data.letter || name.charAt(0), 2) || '?';
  const color = cleanText(data.color || '#a29bfe', 20) || '#a29bfe';
  const npc = {
    id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: name, letter: letter, color: color, lines: lines,
    x: clamp(data.x != null ? data.x : (400 + Math.random() * 400), 80, MAP_W - 80),
    y: clamp(data.y != null ? data.y : (200 + Math.random() * 400), 80, MAP_H - 80),
    ts: Date.now()
  };
  world.customNpcs.push(npc);
  if (world.customNpcs.length > MAX_NPCS) world.customNpcs.shift();
  saveWorld();
  io.emit('world:customNpc', npc);
  return npc;
}

function addPhoto(dataUrl, caption, x, y) {
  const raw = String(dataUrl || '');
  if (raw.indexOf('data:image/') !== 0) throw new Error('Gecersiz gorsel.');
  if (raw.length > MAX_PHOTO_BYTES) throw new Error('Fotograf cok buyuk.');
  const photo = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    dataUrl: raw,
    caption: cleanText(caption, 80),
    x: clamp(x != null ? x : (MAP_W / 2 + (Math.random() - 0.5) * 300), 80, MAP_W - 80),
    y: clamp(y != null ? y : (MAP_H / 2 + (Math.random() - 0.5) * 200), 80, MAP_H - 80),
    ts: Date.now()
  };
  world.photos.push(photo);
  if (world.photos.length > MAX_PHOTOS) world.photos.shift();
  saveWorld();
  io.emit('world:photo', { id: photo.id, x: photo.x, y: photo.y, caption: photo.caption, dataUrl: photo.dataUrl });
  return photo;
}

function clearCustomNpcs() {
  world.customNpcs = [];
  saveWorld();
  io.emit('world:customNpcsCleared');
}
function clearPhotos() {
  world.photos = [];
  saveWorld();
  io.emit('world:photosCleared');
}

function pushLog(cmd, summary) {
  world.adminLog.push({ ts: Date.now(), cmd: cleanText(cmd, 200), resultSummary: cleanText(summary, 200) });
  if (world.adminLog.length > MAX_LOG) world.adminLog.shift();
  saveWorld();
}

function touchVisitor(deviceId, name) {
  const id = cleanText(deviceId || '', 40) || ('anon' + Date.now());
  const nm = cleanName(name);
  let v = world.visitors[id];
  const now = Date.now();
  if (!v) {
    v = { id: id, name: nm, firstSeen: now, lastSeen: now, visits: 1, actions: [] };
    world.visitors[id] = v;
  } else {
    v.name = nm || v.name;
    v.lastSeen = now;
    v.visits = (v.visits || 0) + 1;
  }
  saveWorld();
  return v;
}

function pushVisitorAction(deviceId, name, type, detail, x, y) {
  const id = cleanText(deviceId || '', 40);
  if (!id) return;
  let v = world.visitors[id];
  if (!v) v = touchVisitor(id, name);
  else {
    v.name = cleanName(name) || v.name;
    v.lastSeen = Date.now();
  }
  v.actions = v.actions || [];
  v.actions.push({
    ts: Date.now(),
    type: cleanText(type, 24) || 'act',
    detail: detail && typeof detail === 'object' ? detail : {},
    x: clamp(x, 0, MAP_W),
    y: clamp(y, 0, MAP_H)
  });
  if (v.actions.length > MAX_ACTIONS_PER_VISITOR) v.actions = v.actions.slice(-MAX_ACTIONS_PER_VISITOR);
  saveWorld();
}

function rangeMs(range) {
  const map = { '1h': 3600000, '1d': 86400000, '7d': 604800000, '30d': 2592000000, '365d': 31536000000, 'all': 0 };
  return map[range] != null ? map[range] : map['1d'];
}

function listVisitors(range) {
  const ms = rangeMs(range);
  const now = Date.now();
  return Object.values(world.visitors || {})
    .filter(function (v) { return !ms || (now - (v.lastSeen || 0) <= ms); })
    .sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); })
    .slice(0, 100)
    .map(function (v) {
      return {
        id: v.id, name: v.name, firstSeen: v.firstSeen, lastSeen: v.lastSeen, visits: v.visits,
        recentActions: (v.actions || []).slice(-12).reverse()
      };
    });
}

const ALLOWED_ACTIONS = { sign: 1, toggle_night: 1, clear_signs: 1, add_npc: 1, clear_npcs: 1, clear_photos: 1 };

const SYSTEM_PROMPT = 'Sen PENIONTALE yonetici motorusun. Sadece tek JSON dondur. NPC: {"action":"add_npc","name":"Isim","letter":"A","color":"#a29bfe","lines":["d1","d2"]}. Ilan: {"action":"sign","text":"duyuru"}. Gece: {"action":"toggle_night"}. Temizle: clear_signs|clear_npcs|clear_photos. NPC isteniyorsa add_npc kullan.';

async function interpretCommand(text) {
  function asSign() { return { action: 'sign', text: text }; }
  if (!GEMINI_API_KEY) return asSign();
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: text }] }],
        generationConfig: { maxOutputTokens: 512, temperature: 0.2, responseMimeType: 'application/json' }
      })
    });
  } catch (e) {
    console.warn('Gemini fetch error:', e.message);
    return asSign();
  }
  if (!res.ok) {
    const errBody = await res.text().catch(function () { return ''; });
    console.warn('Gemini HTTP', res.status, errBody.slice(0, 120));
    return asSign();
  }
  let data;
  try { data = await res.json(); } catch (e) { return asSign(); }
  const parts = ((data.candidates || [])[0] && (data.candidates || [])[0].content && (data.candidates || [])[0].content.parts) || [];
  const raw = parts.map(function (p) { return p.text || ''; }).join('').trim();
  if (!raw) return asSign();
  function tryParse(str) { try { return JSON.parse(str); } catch (e) { return null; } }
  let parsed = tryParse(raw);
  if (!parsed) {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = tryParse(cleaned);
  }
  if (!parsed) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) parsed = tryParse(raw.slice(start, end + 1));
  }
  if (!parsed || !ALLOWED_ACTIONS[parsed.action]) return asSign();
  if (parsed.action === 'sign' && !parsed.text) parsed.text = text;
  return parsed;
}

function applyAction(action) {
  if (action.action === 'sign') {
    const angle = Math.random() * Math.PI * 2;
    const sign = addSign(action.text, MAP_W / 2 + Math.cos(angle) * 260, MAP_H / 2 + Math.sin(angle) * 180);
    return 'Ilan eklendi: ' + sign.text;
  }
  if (action.action === 'add_npc') {
    return 'NPC eklendi: ' + addCustomNpc(action).name;
  }
  if (action.action === 'toggle_night') {
    world.isNight = !world.isNight;
    saveWorld();
    io.emit('world:night', { isNight: world.isNight, by: 'admin' });
    return world.isNight ? 'Geceye cevrildi.' : 'Gunduze cevrildi.';
  }
  if (action.action === 'clear_signs') { clearSigns(); return 'Ilanlar temizlendi.'; }
  if (action.action === 'clear_npcs') { clearCustomNpcs(); return 'NPC ler temizlendi.'; }
  if (action.action === 'clear_photos') { clearPhotos(); return 'Fotograflar temizlendi.'; }
  return 'Bilinmeyen eylem.';
}

const lastAdminCmdAt = new Map();

io.on('connection', function (socket) {
  socket.on('player:join', function (data) {
    if (players.has(socket.id)) return;
    const p = {
      id: socket.id,
      name: cleanName(data && data.name),
      x: clamp(data && data.x, 40, MAP_W - 82),
      y: clamp(data && data.y, 40, MAP_H - 100),
      facing: ['up', 'down', 'left', 'right'].indexOf(data && data.facing) >= 0 ? data.facing : 'down'
    };
    players.set(socket.id, p);
    if (data && data.deviceId) touchVisitor(data.deviceId, p.name);
    socket.emit('world:init', {
      you: socket.id,
      players: Array.from(players.values()).map(publicPlayer),
      isNight: world.isNight,
      collectedStars: world.collectedStars,
      signs: world.signs,
      customNpcs: world.customNpcs,
      photos: world.photos
    });
    socket.broadcast.emit('player:joined', publicPlayer(p));
    broadcastPlayers();
  });

  socket.on('player:move', function (data) {
    const p = players.get(socket.id);
    if (!p) return;
    p.x = clamp(data && data.x, 40, MAP_W - 82);
    p.y = clamp(data && data.y, 40, MAP_H - 100);
    if (['up', 'down', 'left', 'right'].indexOf(data && data.facing) >= 0) p.facing = data.facing;
    socket.broadcast.emit('player:moved', publicPlayer(p));
  });

  socket.on('player:action', function (data) {
    const p = players.get(socket.id);
    if (!p) return;
    const text = String((data && data.text) || '').replace(/[<>]/g, '').slice(0, 32);
    if (text) io.emit('world:playerAction', { id: p.id, name: p.name, text: text });
  });

  socket.on('player:log', function (data) {
    try {
      if (!players.has(socket.id)) return;
      const p = players.get(socket.id);
      pushVisitorAction(data && data.deviceId, (data && data.name) || (p && p.name), data && data.type, data && data.detail, data && data.x, data && data.y);
    } catch (e) { console.warn('player:log', e.message); }
  });

  socket.on('world:toggleNight', function () {
    if (!players.has(socket.id)) return;
    world.isNight = !world.isNight;
    saveWorld();
    io.emit('world:night', { isNight: world.isNight, by: socket.id });
  });

  socket.on('world:collectStar', function (data) {
    if (!players.has(socket.id)) return;
    const id = String((data && data.starId) || '');
    if (['1', '2', '3'].indexOf(id) < 0) return;
    if (world.collectedStars[id]) return;
    world.collectedStars[id] = true;
    saveWorld();
    io.emit('world:star', { starId: id, by: socket.id });
  });

  socket.on('admin:command', async function (data, callback) {
    const ack = typeof callback === 'function' ? callback : function () {};
    try {
      if (!data || data.pass !== ADMIN_PASS) return ack({ ok: false, error: 'Yanlis sifre.' });
      const text = cleanText(data.text, 400);
      if (!text) return ack({ ok: false, error: 'Bos komut.' });
      const now = Date.now();
      const last = lastAdminCmdAt.get(socket.id) || 0;
      if (now - last < 4000) return ack({ ok: false, error: 'Cok hizli, bekle.' });
      lastAdminCmdAt.set(socket.id, now);

      let action;
      const low = text.toLowerCase();
      const wantsNpc = /(npc|karakter|kisi ekle|biri ekle)/i.test(text) && !/(ilan|duyuru|pano|temizle|gece|gunduz)/i.test(low);
      if (wantsNpc) {
        action = await interpretCommand(text);
        if (!action || action.action !== 'add_npc') {
          action = {
            action: 'add_npc', name: 'Yeni Karakter', letter: '?', color: '#a29bfe',
            lines: ['Merhaba. Ben yeni bir kamp sakiniyim.', cleanText(text, 100), 'Hero Kampi ilginc bir yer.']
          };
        }
      } else {
        action = await interpretCommand(text);
      }
      const summary = applyAction(action);
      pushLog(text, summary);
      ack({ ok: true, summary: summary, action: action.action });
    } catch (e) {
      console.error('admin:command', e.message);
      ack({ ok: false, error: 'Hata: ' + e.message });
    }
  });

  socket.on('admin:visitors', function (data, callback) {
    const ack = typeof callback === 'function' ? callback : function () {};
    try {
      if (!data || data.pass !== ADMIN_PASS) return ack({ ok: false, error: 'Yanlis sifre.' });
      ack({ ok: true, visitors: listVisitors(data.range || '1d') });
    } catch (e) { ack({ ok: false, error: e.message || 'Hata' }); }
  });

  socket.on('admin:photo', function (data, callback) {
    const ack = typeof callback === 'function' ? callback : function () {};
    try {
      if (!data || data.pass !== ADMIN_PASS) return ack({ ok: false, error: 'Yanlis sifre.' });
      const photo = addPhoto(data.dataUrl, data.caption || '', data.x, data.y);
      pushLog('[foto]', 'Foto eklendi ' + photo.id);
      ack({ ok: true, summary: 'Fotograf haritaya eklendi.' });
    } catch (e) { ack({ ok: false, error: e.message || 'Foto eklenemedi.' }); }
  });

  socket.on('disconnect', function () {
    if (players.delete(socket.id)) {
      socket.broadcast.emit('player:left', { id: socket.id });
      broadcastPlayers();
    }
  });
});

server.listen(PORT, function () {
  console.log('Peniontale multiplayer server: http://localhost:' + PORT);
  if (!GEMINI_API_KEY) console.warn('UYARI: GEMINI_API_KEY yok');
});
\}/);
    if (m) parsed = tryParse(m[0]);
  }
  if (!parsed) {
    const m = raw.match(/"action"\s*:\s*"(\w+)"[\s\S]*?"text"\s*:\s*"([^"]*)/);
    if (m && ALLOWED_ACTIONS.has(m[1])) {
      parsed = { action: m[1], text: m[2] || text };
    }
  }

  if (!parsed || !ALLOWED_ACTIONS.has(parsed.action)) {
    return asSign();
  }
  if (parsed.action === 'sign' && !parsed.text) parsed.text = text;
  return parsed;
}

function applyAction(action) {
  switch (action.action) {
    case 'sign': {
      const angle = Math.random() * Math.PI * 2;
      const cx = MAP_W / 2 + Math.cos(angle) * 260;
      const cy = MAP_H / 2 + Math.sin(angle) * 180;
      const sign = addSign(action.text, cx, cy);
      return "Ilan eklendi: " + JSON.stringify(sign.text);
    }
    case 'add_npc': {
      const npc = addCustomNpc(action);
      return "NPC eklendi: " + npc.name + " (E ile konus)";
    }
    case 'toggle_night': {
      world.isNight = !world.isNight;
      saveWorld();
      io.emit('world:night', { isNight: world.isNight, by: 'admin' });
      return world.isNight ? "Geceye cevrildi." : "Gunduze cevrildi.";
    }
    case 'clear_signs': {
      clearSigns();
      return "Tum ilanlar temizlendi.";
    }
    case 'clear_npcs': {
      clearCustomNpcs();
      return "Ozel NPC ler temizlendi.";
    }
    case 'clear_photos': {
      clearPhotos();
      return "Fotograflar temizlendi.";
    }
    default:
      return "Bilinmeyen eylem.";
  }
}

// Basit hız sınırlama: aynı bağlantı 4 saniyede bir komut gönderebilir.

const MAX_ACTIONS_PER_VISITOR = 80;

function touchVisitor(deviceId, name) {
  const id = cleanText(deviceId || '', 40) || ('anon' + Date.now());
  const nm = cleanName(name);
  let v = world.visitors[id];
  const now = Date.now();
  if (!v) {
    v = { id, name: nm, firstSeen: now, lastSeen: now, visits: 1, actions: [] };
    world.visitors[id] = v;
  } else {
    v.name = nm || v.name;
    v.lastSeen = now;
    v.visits = (v.visits || 0) + 1;
  }
  saveWorld();
  return v;
}

function pushVisitorAction(deviceId, name, type, detail, x, y) {
  const id = cleanText(deviceId || '', 40);
  if (!id) return;
  let v = world.visitors[id];
  if (!v) v = touchVisitor(id, name);
  else {
    v.name = cleanName(name) || v.name;
    v.lastSeen = Date.now();
  }
  v.actions = v.actions || [];
  v.actions.push({
    ts: Date.now(),
    type: cleanText(type, 24) || 'act',
    detail: detail && typeof detail === 'object' ? detail : {},
    x: clamp(x, 0, MAP_W),
    y: clamp(y, 0, MAP_H)
  });
  if (v.actions.length > MAX_ACTIONS_PER_VISITOR) {
    v.actions = v.actions.slice(-MAX_ACTIONS_PER_VISITOR);
  }
  saveWorld();
}

function rangeMs(range) {
  const map = {
    '1h': 3600000,
    '1d': 86400000,
    '7d': 604800000,
    '30d': 2592000000,
    '365d': 31536000000,
    'all': 0
  };
  return map[range] != null ? map[range] : map['1d'];
}

function listVisitors(range) {
  const ms = rangeMs(range);
  const now = Date.now();
  const arr = Object.values(world.visitors || {});
  return arr
    .filter(v => !ms || (now - (v.lastSeen || 0) <= ms))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 100)
    .map(v => ({
      id: v.id,
      name: v.name,
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
      visits: v.visits,
      recentActions: (v.actions || []).slice(-12).reverse()
    }));
}


const lastAdminCmdAt = new Map();

io.on('connection', socket => {
  socket.on('player:join', data => {
    if(players.has(socket.id)) return;
    const p = {
      id: socket.id,
      name: cleanName(data?.name),
      x: clamp(data?.x, 40, MAP_W - 82),
      y: clamp(data?.y, 40, MAP_H - 100),
      facing: ['up','down','left','right'].includes(data?.facing) ? data.facing : 'down'
    };
    players.set(socket.id, p);
    if (data?.deviceId) touchVisitor(data.deviceId, p.name);

    socket.emit('world:init', {
      you: socket.id,
      players: [...players.values()].map(publicPlayer),
      isNight: world.isNight,
      collectedStars: world.collectedStars,
      signs: world.signs,
      customNpcs: world.customNpcs,
      photos: world.photos
    });
    socket.broadcast.emit('player:joined', publicPlayer(p));
    broadcastPlayers();
  });

  socket.on('player:move', data => {
    const p=players.get(socket.id);
    if(!p) return;
    p.x=clamp(data?.x,40,MAP_W-82);
    p.y=clamp(data?.y,40,MAP_H-100);
    if(['up','down','left','right'].includes(data?.facing)) p.facing=data.facing;
    socket.broadcast.emit('player:moved', publicPlayer(p));
  });

  socket.on('player:action', data => {
    const p=players.get(socket.id);
    if(!p) return;
    const text=String(data?.text || '').replace(/[<>]/g,'').slice(0,32);
    if(text) io.emit('world:playerAction',{id:p.id,name:p.name,text});
  });

  socket.on('world:toggleNight', () => {
    if(!players.has(socket.id)) return;
    world.isNight=!world.isNight;
    saveWorld();
    io.emit('world:night',{isNight:world.isNight,by:socket.id});
  });

  socket.on('world:collectStar', data => {
    if(!players.has(socket.id)) return;
    const id=String(data?.starId || '');
    if(!['1','2','3'].includes(id)) return;
    if(world.collectedStars[id]) return;
    world.collectedStars[id]=true;
    saveWorld();
    io.emit('world:star',{starId:id,by:socket.id});
  });

  // ---- Gizli panel: AI ile oyuna kalıcı ekleme yapma ----
  socket.on('admin:command', async (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      if (!data || data.pass !== ADMIN_PASS) {
        return ack({ ok: false, error: 'Yanlış şifre.' });
      }
      const text = cleanText(data.text, 400);
      if (!text) return ack({ ok: false, error: 'Boş komut.' });

      const now = Date.now();
      const last = lastAdminCmdAt.get(socket.id) || 0;
      if (now - last < 4000) {
        return ack({ ok: false, error: 'Çok hızlı — birkaç saniye bekle.' });
      }
      lastAdminCmdAt.set(socket.id, now);

      let action;
      const low = text.toLowerCase();
      // Hızlı yol: NPC isteniyorsa AI'ye bırakmadan da net istek
      if (/\b(npc|karakter|kişi ekle|biri ekle)\b/i.test(text) && !/ilan|duyuru|pano|temizle|gece|gündüz/.test(low)) {
        action = await interpretCommand(text);
        if (!action || action.action !== 'add_npc') {
          // AI sign döndürdüyse zorla npc iskeleti
          action = {
            action: 'add_npc',
            name: (action && action.text) ? String(action.text).slice(0, 24) : 'Yeni Karakter',
            letter: '?',
            color: '#a29bfe',
            lines: [
              'Merhaba. Ben yeni bir kamp sakiniyim.',
              cleanText(text, 100),
              'Hero Kampı… ilginç bir yer.'
            ]
          };
          // isim düzelt
          if (action.name.length > 20 || action.name.includes(' ')) {
            /* keep */
          }
        }
      } else {
        action = await interpretCommand(text);
      }
      const summary = applyAction(action);
      pushLog(text, summary);
      ack({ ok: true, summary, action: action.action });
    } catch (e) {
      console.error('admin:command hata:', e.message);
      ack({ ok: false, error: 'Hata: ' + e.message });
    }
  });


  socket.on('player:log', data => {
    try {
      if (!players.has(socket.id)) return;
      pushVisitorAction(
        data?.deviceId,
        data?.name || players.get(socket.id)?.name,
        data?.type,
        data?.detail,
        data?.x,
        data?.y
      );
    } catch (e) { console.warn('player:log', e.message); }
  });

  socket.on('admin:visitors', (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      if (!data || data.pass !== ADMIN_PASS) return ack({ ok: false, error: 'Yanlış şifre.' });
      const range = data.range || '1d';
      ack({ ok: true, visitors: listVisitors(range) });
    } catch (e) {
      ack({ ok: false, error: e.message || 'Hata' });
    }
  });

  socket.on('admin:photo', (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      if (!data || data.pass !== ADMIN_PASS) return ack({ ok: false, error: 'Yanlış şifre.' });
      const photo = addPhoto(data.dataUrl, data.caption || '', data.x, data.y);
      pushLog('[foto]', 'Foto eklendi ' + photo.id);
      ack({ ok: true, summary: 'Fotoğraf haritaya eklendi.' });
    } catch (e) {
      ack({ ok: false, error: e.message || 'Foto eklenemedi.' });
    }
  });

  socket.on('disconnect', () => {
    if(players.delete(socket.id)) {
      socket.broadcast.emit('player:left',{id:socket.id});
      broadcastPlayers();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Peniontale multiplayer server: http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.warn('UYARI: GEMINI_API_KEY tanımlı değil — admin paneldeki AI, komutları ham ilan metni olarak ekleyecek (Gemini yorumlaması olmadan).');
  }
});
\}/);
    if (m) parsed = tryParse(m[0]);
  }
  if (!parsed) {
    const m = raw.match(/"action"\s*:\s*"(\w+)"[\s\S]*?"text"\s*:\s*"([^"]*)/);
    if (m && ALLOWED_ACTIONS.has(m[1])) {
      parsed = { action: m[1], text: m[2] || text };
    }
  }

  if (!parsed || !ALLOWED_ACTIONS.has(parsed.action)) {
    return asSign();
  }
  if (parsed.action === 'sign' && !parsed.text) parsed.text = text;
  return parsed;
}

function applyAction(action) {
  switch (action.action) {
    case 'sign': {
      const angle = Math.random() * Math.PI * 2;
      const cx = MAP_W / 2 + Math.cos(angle) * 260;
      const cy = MAP_H / 2 + Math.sin(angle) * 180;
      const sign = addSign(action.text, cx, cy);
      return 'İlan eklendi: "' + sign.text + '"';
    }
    case 'add_npc': {
      const npc = addCustomNpc(action);
      return 'NPC eklendi: ' + npc.name + ' (E ile konuş)';
    }
    case 'toggle_night': {
      world.isNight = !world.isNight;
      saveWorld();
      io.emit('world:night', { isNight: world.isNight, by: 'admin' });
      return world.isNight ? 'Geceye çevrildi.' : 'Gündüze çevrildi.';
    }
    case 'clear_signs': {
      clearSigns();
      return 'Tüm ilanlar temizlendi.';
    }
    case 'clear_npcs': {
      clearCustomNpcs();
      return "Özel NPC ler temizlendi.";
    }
    case 'clear_photos': {
      clearPhotos();
      return 'Fotoğraflar temizlendi.';
    }
    default:
      return 'Bilinmeyen eylem.';
  }
}

// Basit hız sınırlama: aynı bağlantı 4 saniyede bir komut gönderebilir.

const MAX_ACTIONS_PER_VISITOR = 80;

function touchVisitor(deviceId, name) {
  const id = cleanText(deviceId || '', 40) || ('anon' + Date.now());
  const nm = cleanName(name);
  let v = world.visitors[id];
  const now = Date.now();
  if (!v) {
    v = { id, name: nm, firstSeen: now, lastSeen: now, visits: 1, actions: [] };
    world.visitors[id] = v;
  } else {
    v.name = nm || v.name;
    v.lastSeen = now;
    v.visits = (v.visits || 0) + 1;
  }
  saveWorld();
  return v;
}

function pushVisitorAction(deviceId, name, type, detail, x, y) {
  const id = cleanText(deviceId || '', 40);
  if (!id) return;
  let v = world.visitors[id];
  if (!v) v = touchVisitor(id, name);
  else {
    v.name = cleanName(name) || v.name;
    v.lastSeen = Date.now();
  }
  v.actions = v.actions || [];
  v.actions.push({
    ts: Date.now(),
    type: cleanText(type, 24) || 'act',
    detail: detail && typeof detail === 'object' ? detail : {},
    x: clamp(x, 0, MAP_W),
    y: clamp(y, 0, MAP_H)
  });
  if (v.actions.length > MAX_ACTIONS_PER_VISITOR) {
    v.actions = v.actions.slice(-MAX_ACTIONS_PER_VISITOR);
  }
  saveWorld();
}

function rangeMs(range) {
  const map = {
    '1h': 3600000,
    '1d': 86400000,
    '7d': 604800000,
    '30d': 2592000000,
    '365d': 31536000000,
    'all': 0
  };
  return map[range] != null ? map[range] : map['1d'];
}

function listVisitors(range) {
  const ms = rangeMs(range);
  const now = Date.now();
  const arr = Object.values(world.visitors || {});
  return arr
    .filter(v => !ms || (now - (v.lastSeen || 0) <= ms))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 100)
    .map(v => ({
      id: v.id,
      name: v.name,
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
      visits: v.visits,
      recentActions: (v.actions || []).slice(-12).reverse()
    }));
}


const lastAdminCmdAt = new Map();

io.on('connection', socket => {
  socket.on('player:join', data => {
    if(players.has(socket.id)) return;
    const p = {
      id: socket.id,
      name: cleanName(data?.name),
      x: clamp(data?.x, 40, MAP_W - 82),
      y: clamp(data?.y, 40, MAP_H - 100),
      facing: ['up','down','left','right'].includes(data?.facing) ? data.facing : 'down'
    };
    players.set(socket.id, p);
    if (data?.deviceId) touchVisitor(data.deviceId, p.name);

    socket.emit('world:init', {
      you: socket.id,
      players: [...players.values()].map(publicPlayer),
      isNight: world.isNight,
      collectedStars: world.collectedStars,
      signs: world.signs,
      customNpcs: world.customNpcs,
      photos: world.photos
    });
    socket.broadcast.emit('player:joined', publicPlayer(p));
    broadcastPlayers();
  });

  socket.on('player:move', data => {
    const p=players.get(socket.id);
    if(!p) return;
    p.x=clamp(data?.x,40,MAP_W-82);
    p.y=clamp(data?.y,40,MAP_H-100);
    if(['up','down','left','right'].includes(data?.facing)) p.facing=data.facing;
    socket.broadcast.emit('player:moved', publicPlayer(p));
  });

  socket.on('player:action', data => {
    const p=players.get(socket.id);
    if(!p) return;
    const text=String(data?.text || '').replace(/[<>]/g,'').slice(0,32);
    if(text) io.emit('world:playerAction',{id:p.id,name:p.name,text});
  });

  socket.on('world:toggleNight', () => {
    if(!players.has(socket.id)) return;
    world.isNight=!world.isNight;
    saveWorld();
    io.emit('world:night',{isNight:world.isNight,by:socket.id});
  });

  socket.on('world:collectStar', data => {
    if(!players.has(socket.id)) return;
    const id=String(data?.starId || '');
    if(!['1','2','3'].includes(id)) return;
    if(world.collectedStars[id]) return;
    world.collectedStars[id]=true;
    saveWorld();
    io.emit('world:star',{starId:id,by:socket.id});
  });

  // ---- Gizli panel: AI ile oyuna kalıcı ekleme yapma ----
  socket.on('admin:command', async (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      if (!data || data.pass !== ADMIN_PASS) {
        return ack({ ok: false, error: 'Yanlış şifre.' });
      }
      const text = cleanText(data.text, 400);
      if (!text) return ack({ ok: false, error: 'Boş komut.' });

      const now = Date.now();
      const last = lastAdminCmdAt.get(socket.id) || 0;
      if (now - last < 4000) {
        return ack({ ok: false, error: 'Çok hızlı — birkaç saniye bekle.' });
      }
      lastAdminCmdAt.set(socket.id, now);

      let action;
      const low = text.toLowerCase();
      // Hızlı yol: NPC isteniyorsa AI'ye bırakmadan da net istek
      if (/\b(npc|karakter|kişi ekle|biri ekle)\b/i.test(text) && !/ilan|duyuru|pano|temizle|gece|gündüz/.test(low)) {
        action = await interpretCommand(text);
        if (!action || action.action !== 'add_npc') {
          // AI sign döndürdüyse zorla npc iskeleti
          action = {
            action: 'add_npc',
            name: (action && action.text) ? String(action.text).slice(0, 24) : 'Yeni Karakter',
            letter: '?',
            color: '#a29bfe',
            lines: [
              'Merhaba. Ben yeni bir kamp sakiniyim.',
              cleanText(text, 100),
              'Hero Kampı… ilginç bir yer.'
            ]
          };
          // isim düzelt
          if (action.name.length > 20 || action.name.includes(' ')) {
            /* keep */
          }
        }
      } else {
        action = await interpretCommand(text);
      }
      const summary = applyAction(action);
      pushLog(text, summary);
      ack({ ok: true, summary, action: action.action });
    } catch (e) {
      console.error('admin:command hata:', e.message);
      ack({ ok: false, error: 'Hata: ' + e.message });
    }
  });


  socket.on('player:log', data => {
    try {
      if (!players.has(socket.id)) return;
      pushVisitorAction(
        data?.deviceId,
        data?.name || players.get(socket.id)?.name,
        data?.type,
        data?.detail,
        data?.x,
        data?.y
      );
    } catch (e) { console.warn('player:log', e.message); }
  });

  socket.on('admin:visitors', (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      if (!data || data.pass !== ADMIN_PASS) return ack({ ok: false, error: 'Yanlış şifre.' });
      const range = data.range || '1d';
      ack({ ok: true, visitors: listVisitors(range) });
    } catch (e) {
      ack({ ok: false, error: e.message || 'Hata' });
    }
  });

  socket.on('admin:photo', (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      if (!data || data.pass !== ADMIN_PASS) return ack({ ok: false, error: 'Yanlış şifre.' });
      const photo = addPhoto(data.dataUrl, data.caption || '', data.x, data.y);
      pushLog('[foto]', 'Foto eklendi ' + photo.id);
      ack({ ok: true, summary: 'Fotoğraf haritaya eklendi.' });
    } catch (e) {
      ack({ ok: false, error: e.message || 'Foto eklenemedi.' });
    }
  });

  socket.on('disconnect', () => {
    if(players.delete(socket.id)) {
      socket.broadcast.emit('player:left',{id:socket.id});
      broadcastPlayers();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Peniontale multiplayer server: http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.warn('UYARI: GEMINI_API_KEY tanımlı değil — admin paneldeki AI, komutları ham ilan metni olarak ekleyecek (Gemini yorumlaması olmadan).');
  }
});
' : 'Gündüze çevrildi.';
    }
    case 'clear_signs': {
      clearSigns();
      return 'Tüm ilanlar temizlendi.';
    }
    case 'clear_npcs': {
      clearCustomNpcs();
      return "Özel NPC ler temizlendi.";
    }
    case 'clear_photos': {
      clearPhotos();
      return 'Fotoğraflar temizlendi.';
    }
    default:
      return 'Bilinmeyen eylem.';
  }
}

// Basit hız sınırlama: aynı bağlantı 4 saniyede bir komut gönderebilir.

const MAX_ACTIONS_PER_VISITOR = 80;

function touchVisitor(deviceId, name) {
  const id = cleanText(deviceId || '', 40) || ('anon' + Date.now());
  const nm = cleanName(name);
  let v = world.visitors[id];
  const now = Date.now();
  if (!v) {
    v = { id, name: nm, firstSeen: now, lastSeen: now, visits: 1, actions: [] };
    world.visitors[id] = v;
  } else {
    v.name = nm || v.name;
    v.lastSeen = now;
    v.visits = (v.visits || 0) + 1;
  }
  saveWorld();
  return v;
}

function pushVisitorAction(deviceId, name, type, detail, x, y) {
  const id = cleanText(deviceId || '', 40);
  if (!id) return;
  let v = world.visitors[id];
  if (!v) v = touchVisitor(id, name);
  else {
    v.name = cleanName(name) || v.name;
    v.lastSeen = Date.now();
  }
  v.actions = v.actions || [];
  v.actions.push({
    ts: Date.now(),
    type: cleanText(type, 24) || 'act',
    detail: detail && typeof detail === 'object' ? detail : {},
    x: clamp(x, 0, MAP_W),
    y: clamp(y, 0, MAP_H)
  });
  if (v.actions.length > MAX_ACTIONS_PER_VISITOR) {
    v.actions = v.actions.slice(-MAX_ACTIONS_PER_VISITOR);
  }
  saveWorld();
}

function rangeMs(range) {
  const map = {
    '1h': 3600000,
    '1d': 86400000,
    '7d': 604800000,
    '30d': 2592000000,
    '365d': 31536000000,
    'all': 0
  };
  return map[range] != null ? map[range] : map['1d'];
}

function listVisitors(range) {
  const ms = rangeMs(range);
  const now = Date.now();
  const arr = Object.values(world.visitors || {});
  return arr
    .filter(v => !ms || (now - (v.lastSeen || 0) <= ms))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 100)
    .map(v => ({
      id: v.id,
      name: v.name,
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
      visits: v.visits,
      recentActions: (v.actions || []).slice(-12).reverse()
    }));
}


const lastAdminCmdAt = new Map();

io.on('connection', socket => {
  socket.on('player:join', data => {
    if(players.has(socket.id)) return;
    const p = {
      id: socket.id,
      name: cleanName(data?.name),
      x: clamp(data?.x, 40, MAP_W - 82),
      y: clamp(data?.y, 40, MAP_H - 100),
      facing: ['up','down','left','right'].includes(data?.facing) ? data.facing : 'down'
    };
    players.set(socket.id, p);
    if (data?.deviceId) touchVisitor(data.deviceId, p.name);

    socket.emit('world:init', {
      you: socket.id,
      players: [...players.values()].map(publicPlayer),
      isNight: world.isNight,
      collectedStars: world.collectedStars,
      signs: world.signs,
      customNpcs: world.customNpcs,
      photos: world.photos
    });
    socket.broadcast.emit('player:joined', publicPlayer(p));
    broadcastPlayers();
  });

  socket.on('player:move', data => {
    const p=players.get(socket.id);
    if(!p) return;
    p.x=clamp(data?.x,40,MAP_W-82);
    p.y=clamp(data?.y,40,MAP_H-100);
    if(['up','down','left','right'].includes(data?.facing)) p.facing=data.facing;
    socket.broadcast.emit('player:moved', publicPlayer(p));
  });

  socket.on('player:action', data => {
    const p=players.get(socket.id);
    if(!p) return;
    const text=String(data?.text || '').replace(/[<>]/g,'').slice(0,32);
    if(text) io.emit('world:playerAction',{id:p.id,name:p.name,text});
  });

  socket.on('world:toggleNight', () => {
    if(!players.has(socket.id)) return;
    world.isNight=!world.isNight;
    saveWorld();
    io.emit('world:night',{isNight:world.isNight,by:socket.id});
  });

  socket.on('world:collectStar', data => {
    if(!players.has(socket.id)) return;
    const id=String(data?.starId || '');
    if(!['1','2','3'].includes(id)) return;
    if(world.collectedStars[id]) return;
    world.collectedStars[id]=true;
    saveWorld();
    io.emit('world:star',{starId:id,by:socket.id});
  });

  // ---- Gizli panel: AI ile oyuna kalıcı ekleme yapma ----
  socket.on('admin:command', async (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      if (!data || data.pass !== ADMIN_PASS) {
        return ack({ ok: false, error: 'Yanlış şifre.' });
      }
      const text = cleanText(data.text, 400);
      if (!text) return ack({ ok: false, error: 'Boş komut.' });

      const now = Date.now();
      const last = lastAdminCmdAt.get(socket.id) || 0;
      if (now - last < 4000) {
        return ack({ ok: false, error: 'Çok hızlı — birkaç saniye bekle.' });
      }
      lastAdminCmdAt.set(socket.id, now);

      let action;
      const low = text.toLowerCase();
      // Hızlı yol: NPC isteniyorsa AI'ye bırakmadan da net istek
      if (/\b(npc|karakter|kişi ekle|biri ekle)\b/i.test(text) && !/ilan|duyuru|pano|temizle|gece|gündüz/.test(low)) {
        action = await interpretCommand(text);
        if (!action || action.action !== 'add_npc') {
          // AI sign döndürdüyse zorla npc iskeleti
          action = {
            action: 'add_npc',
            name: (action && action.text) ? String(action.text).slice(0, 24) : 'Yeni Karakter',
            letter: '?',
            color: '#a29bfe',
            lines: [
              'Merhaba. Ben yeni bir kamp sakiniyim.',
              cleanText(text, 100),
              'Hero Kampı… ilginç bir yer.'
            ]
          };
          // isim düzelt
          if (action.name.length > 20 || action.name.includes(' ')) {
            /* keep */
          }
        }
      } else {
        action = await interpretCommand(text);
      }
      const summary = applyAction(action);
      pushLog(text, summary);
      ack({ ok: true, summary, action: action.action });
    } catch (e) {
      console.error('admin:command hata:', e.message);
      ack({ ok: false, error: 'Hata: ' + e.message });
    }
  });


  socket.on('player:log', data => {
    try {
      if (!players.has(socket.id)) return;
      pushVisitorAction(
        data?.deviceId,
        data?.name || players.get(socket.id)?.name,
        data?.type,
        data?.detail,
        data?.x,
        data?.y
      );
    } catch (e) { console.warn('player:log', e.message); }
  });

  socket.on('admin:visitors', (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      if (!data || data.pass !== ADMIN_PASS) return ack({ ok: false, error: 'Yanlış şifre.' });
      const range = data.range || '1d';
      ack({ ok: true, visitors: listVisitors(range) });
    } catch (e) {
      ack({ ok: false, error: e.message || 'Hata' });
    }
  });

  socket.on('admin:photo', (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      if (!data || data.pass !== ADMIN_PASS) return ack({ ok: false, error: 'Yanlış şifre.' });
      const photo = addPhoto(data.dataUrl, data.caption || '', data.x, data.y);
      pushLog('[foto]', 'Foto eklendi ' + photo.id);
      ack({ ok: true, summary: 'Fotoğraf haritaya eklendi.' });
    } catch (e) {
      ack({ ok: false, error: e.message || 'Foto eklenemedi.' });
    }
  });

  socket.on('disconnect', () => {
    if(players.delete(socket.id)) {
      socket.broadcast.emit('player:left',{id:socket.id});
      broadcastPlayers();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Peniontale multiplayer server: http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.warn('UYARI: GEMINI_API_KEY tanımlı değil — admin paneldeki AI, komutları ham ilan metni olarak ekleyecek (Gemini yorumlaması olmadan).');
  }
});ale multiplayer server: http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.warn('UYARI: GEMINI_API_KEY tanımlı değil — admin paneldeki AI, komutları ham ilan metni olarak ekleyecek (Gemini yorumlaması olmadan).');
  }
});
