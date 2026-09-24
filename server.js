const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const MAP_W = 1280;
const MAP_H = 960;

// Yönetici şifresi: client'taki gizli panel şifresiyle aynı olmalı (varsayılan: 'peniontale').
// Render'da ADMIN_PASS env değişkeniyle değiştirebilirsin.
const ADMIN_PASS = process.env.ADMIN_PASS || 'peniontale';

// Gemini API ayarları (ücretsiz, kredi kartı istemez) — Render'da GEMINI_API_KEY env değişkenini eklemen ZORUNLU.
// Key almak için: aistudio.google.com -> "Get API key".
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const players = new Map();

// ---- Kalıcı dünya durumu (disk üzerinde JSON dosyası) ----
const STATE_FILE = path.join(__dirname, 'world-state.json');
const MAX_SIGNS = 40;
const MAX_LOG = 60;

let world = {
  isNight: false,
  collectedStars: Object.create(null),
  signs: [],        // [{id, text, x, y, ts}]  -> AI'nin oyuna eklediği kalıcı ilan panoları
  adminLog: []       // [{ts, cmd, resultSummary}] -> panelde geçmişi görmek için
};

function loadWorld() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    world.isNight = !!saved.isNight;
    world.collectedStars = saved.collectedStars || Object.create(null);
    world.signs = Array.isArray(saved.signs) ? saved.signs : [];
    world.adminLog = Array.isArray(saved.adminLog) ? saved.adminLog : [];
  } catch (e) {
    // Dosya yok veya bozuk — sıfırdan başla.
  }
}
let saveTimer = null;
function saveWorld() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(world)); }
    catch (e) { console.error('world-state.json yazılamadı:', e.message); }
  }, 250);
}
loadWorld();

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'Peniontale_Multiplayer.html')));

function clamp(v, min, max){ return Math.max(min, Math.min(max, Number(v) || 0)); }
function cleanName(v){
  const n = String(v || 'Oyuncu').replace(/[<>]/g,'').trim().slice(0,18);
  return n || 'Oyuncu';
}
function cleanText(v, maxLen){
  return String(v || '').replace(/[<>`]/g,'').replace(/\s+/g,' ').trim().slice(0, maxLen);
}
function publicPlayer(p){
  return { id:p.id, name:p.name, x:p.x, y:p.y, facing:p.facing };
}
function broadcastPlayers(){
  io.emit('world:players', [...players.values()].map(publicPlayer));
}

function addSign(text, x, y){
  const sign = {
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    text: cleanText(text, 140) || '(boş ilan)',
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
function clearSigns(){
  world.signs = [];
  saveWorld();
  io.emit('world:signsCleared');
}
function pushLog(cmd, summary){
  world.adminLog.push({ ts: Date.now(), cmd: cleanText(cmd, 200), resultSummary: cleanText(summary, 200) });
  if (world.adminLog.length > MAX_LOG) world.adminLog.shift();
  saveWorld();
}

// ---- Claude API ile komutu bir oyun eylemine çevir ----
const ALLOWED_ACTIONS = new Set(['sign', 'toggle_night', 'clear_signs']);

const SYSTEM_PROMPT = `Sen PENIONTALE adlı bir 2D oyunun gizli yönetici panelinin arkasında çalışan bir motor-asistanısın.
Yönetici sana Türkçe (veya başka bir dilde) serbest metinli bir komut yazacak.
Bu komutu, oyuna uygulanacak TEK bir JSON eylemine çevir. SADECE geçerli JSON döndür — açıklama, markdown, kod bloğu, tırnak dışı metin YOK.

İzin verilen eylemler:
1. {"action":"sign","text":"..."} — Oyun haritasına AI'nin ürettiği kısa (en fazla 140 karakter) bir ilan/duyuru panosu ekler. Bu, "oyuna bir şey ekle" türündeki her komut için varsayılan eylemdir: komutun anlamını oyunun fantastik/sıcak tarzına uygun kısa bir duyuru metnine çevir.
2. {"action":"toggle_night"} — Sadece komut açıkça gece/gündüz değiştirmeyi istiyorsa kullan.
3. {"action":"clear_signs"} — Sadece komut açıkça tüm ilanları/panoları temizlemeyi istiyorsa kullan.

Emin değilsen ya da komut bu üç tipe net biçimde uymuyorsa, her zaman "sign" eylemini seç ve komutun içeriğini kısa bir duyuru metni haline getir. Böylece her komut oyuna görünür bir şekilde yansır. Yanıtın SADECE JSON olsun, başka hiçbir şey ekleme.`;

async function interpretCommand(text) {
  if (!GEMINI_API_KEY) {
    // API anahtarı yoksa: en azından ham metni doğrudan ilan olarak ekle, sistem çökmesin.
    return { action: 'sign', text, _fallback: 'no_api_key' };
  }
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: text }] }],
      generationConfig: { maxOutputTokens: 300 }
    })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error('Gemini API hatası ' + res.status + ': ' + errBody.slice(0, 200));
  }
  const data = await res.json();
  const raw = ((data.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini JSON döndürmedi: ' + raw.slice(0, 120));
  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch (e) { throw new Error('JSON parse edilemedi: ' + raw.slice(0, 120)); }
  if (!parsed || !ALLOWED_ACTIONS.has(parsed.action)) {
    // Beklenmeyen bir şey döndüyse yine de kaybetme, ilan olarak ekle.
    return { action: 'sign', text, _fallback: 'invalid_action' };
  }
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
    default:
      return 'Bilinmeyen eylem.';
  }
}

// Basit hız sınırlama: aynı bağlantı 4 saniyede bir komut gönderebilir.
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

    socket.emit('world:init', {
      you: socket.id,
      players: [...players.values()].map(publicPlayer),
      isNight: world.isNight,
      collectedStars: world.collectedStars,
      signs: world.signs
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

      const action = await interpretCommand(text);
      const summary = applyAction(action);
      pushLog(text, summary);
      ack({ ok: true, summary, action: action.action });
    } catch (e) {
      console.error('admin:command hata:', e.message);
      ack({ ok: false, error: 'Hata: ' + e.message });
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
