'use strict';
// Mehmonxona — xonalarni boshqarish serveri (qo'shimcha kutubxonasiz, faqat Node.js)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
let webpush = null;
try { webpush = require('web-push'); } catch { console.log('Diqqat: web-push o\'rnatilmagan — telefonga bildirishnoma ishlamaydi (npm install)'); }

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const MIN = 60000;
const ACTIVE = ['tayinlandi', 'jarayonda'];
const OPEN = ['navbatda', 'tayinlandi', 'jarayonda', 'tekshiruvda'];

// ---------- yordamchilar ----------
function hash(p, salt = crypto.randomBytes(8).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(p), salt, 32).toString('hex');
}
function verify(p, h) {
  if (!h || !h.includes(':')) return false;
  const a = Buffer.from(hash(p, h.split(':')[0])), b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const newCode = () => crypto.randomBytes(4).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

const DEFAULT_SETTINGS = { startLimit: 10, cleanLimit: 20, inspectLimit: 15, telegramToken: '', botUsername: '' };

function seed() {
  const rooms = [
    [101, 1, 'Standart', 'band', 'Aziz Karimov'], [102, 1, 'Standart', 'band', 'Malika Yusupova'],
    [103, 1, 'Deluxe', 'bosh'], [104, 1, 'Deluxe', 'bosh'],
    [201, 2, 'Suite', 'band', 'John Smith'], [202, 2, 'Standart', 'bosh'],
    [203, 2, 'Standart', 'bosh'], [204, 2, 'Deluxe', 'band', 'Dilnoza Rashidova']
  ].map(([num, floor, type, status, guest]) => ({ num, floor, type, status, guest: guest || null, note: '', assignedTo: null }));
  return {
    settings: { ...DEFAULT_SETTINGS },
    staff: [{ id: 1, username: '4455', pass: hash('4455'), name: 'Administrator', role: 'boshqaruv', position: 'Administrator', phone: '', active: true, floors: [], tgCode: newCode(), tgChat: null }],
    floors: [1, 2], rooms, tasks: [], history: [], notifications: [], sessions: {},
    seq: { staff: 2, task: 1, notif: 1 }, tgOffset: 0
  };
}

let db;
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { db = seed(); }
db.settings = { ...DEFAULT_SETTINGS, ...db.settings };
db.staff.forEach(s => { if (!Array.isArray(s.push)) s.push = []; });

// ---------- Web Push (ilovaning o'z bildirishnomalari) ----------
if (webpush) {
  if (!db.settings.vapid) db.settings.vapid = webpush.generateVAPIDKeys();
  webpush.setVapidDetails('mailto:admin@mehmonxona.local', db.settings.vapid.publicKey, db.settings.vapid.privateKey);
}
function pushSend(s, text, { urgent = false, taskId = null } = {}) {
  if (!webpush || !s.push || !s.push.length) return;
  const lines = text.split('\n');
  const payload = JSON.stringify({ title: lines[0], body: lines.slice(1).join('\n'), urgent, tag: taskId ? 'task-' + taskId : 'msg-' + Date.now() });
  s.push.forEach(sub => {
    webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' }).catch(e => {
      if (e.statusCode === 404 || e.statusCode === 410) { s.push = s.push.filter(x => x.endpoint !== sub.endpoint); save(); }
      else console.log('Push xato:', e.statusCode || '', e.body || e.message);
    });
  });
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const json = JSON.stringify(db, null, 1);
    try { fs.writeFileSync(DATA_FILE + '.tmp', json); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
    catch { try { fs.writeFileSync(DATA_FILE, json); } catch (e) { console.error('Saqlashda xato:', e.message); } }
  }, 150);
}
function changed() { save(); broadcast(); }

const S = () => db.settings;
const staffById = id => db.staff.find(s => s.id === id);
const roomByNum = n => db.rooms.find(r => r.num === n);
const isActive = s => s && s.active !== false;
const cleaners = () => db.staff.filter(s => s.role === 'tozalovchi' && isActive(s));
const inspectors = () => db.staff.filter(s => s.role === 'nazoratchi' && isActive(s));
const adminIds = () => db.staff.filter(s => s.role === 'boshqaruv').map(s => s.id);
const activeTaskOf = cid => db.tasks.find(t => t.cleanerId === cid && ACTIVE.includes(t.status));
const canServe = (c, floor) => !c.floors || !c.floors.length || c.floors.includes(floor);
const nameOf = id => (staffById(id) || {}).name || '—';

// ---------- bildirishnomalar ----------
function notify(userIds, text, { level = 'info', taskId = null, buttons = null } = {}) {
  [...new Set(userIds.filter(Boolean))].forEach(uid => {
    db.notifications.push({ id: db.seq.notif++, to: uid, text, level, taskId, ts: Date.now(), read: false });
    const s = staffById(uid);
    if (!s) return;
    pushSend(s, text, { urgent: level === 'warn' || !!buttons, taskId });
    if (s.tgChat) tgSend(s.tgChat, text, buttons);
  });
  if (db.notifications.length > 3000) db.notifications = db.notifications.slice(-2000);
}

// ---------- tozalash vazifalari ----------
function doneToday(cid) {
  const d = new Date().toDateString();
  return db.history.filter(h => h.cleanerId === cid && new Date(h.ts).toDateString() === d).length;
}
// Tozalovchi qachon bo'shashi taxminan
function freeAt(c) {
  const now = Date.now(), cl = S().cleanLimit * MIN;
  let t = now;
  const a = activeTaskOf(c.id);
  if (a) t = a.status === 'jarayonda' ? Math.max(now, a.startedAt + cl) : now + cl;
  return t + db.tasks.filter(x => x.status === 'navbatda' && x.cleanerId === c.id).length * cl;
}

function createTask(room) {
  if (db.tasks.some(t => t.room === room.num && OPEN.includes(t.status))) return;
  const t = {
    id: db.seq.task++, room: room.num, floor: room.floor, status: 'navbatda', cleanerId: null, inspectorId: null,
    createdAt: Date.now(), assignedAt: null, startDeadline: null, startedAt: null, finishedAt: null, inspectedAt: null,
    rework: 0, priority: false, lateStart: false, lateFinish: false, lateInspect: false, reason: ''
  };
  db.tasks.push(t);
  room.status = 'tozalash';
  planTask(t);
}

function planTask(t) {
  let pool = cleaners().filter(c => canServe(c, t.floor));
  if (!pool.length) pool = cleaners();
  if (!pool.length) {
    t.cleanerId = null; t.status = 'navbatda';
    notify(adminIds(), `⚠️ ${t.room}-xonani tozalash kerak, lekin faol tozalovchi yo'q!`, { level: 'warn', taskId: t.id });
    return;
  }
  const free = pool.filter(c => !activeTaskOf(c.id) && !db.tasks.some(x => x.status === 'navbatda' && x.cleanerId === c.id));
  if (free.length) {
    free.sort((a, b) => doneToday(a.id) - doneToday(b.id));
    activate(t, free[0]);
  } else {
    // hamma band — qaysi biri tezroq bo'shasa, o'shanga
    pool.sort((a, b) => freeAt(a) - freeAt(b));
    const c = pool[0], mins = Math.max(1, Math.round((freeAt(c) - Date.now()) / MIN));
    t.cleanerId = c.id; t.status = 'navbatda';
    const r = roomByNum(t.room); if (r) r.assignedTo = c.name;
    notify([c.id], `📋 ${t.room}-xona navbatingizga qo'shildi. Hozirgi ishingizdan keyin boshlaysiz (~${mins} daq).`, { taskId: t.id });
  }
}

function activate(t, c) {
  const now = Date.now();
  Object.assign(t, { cleanerId: c.id, status: 'tayinlandi', assignedAt: now, startDeadline: now + S().startLimit * MIN, startedAt: null, finishedAt: null, lateStart: false, lateFinish: false, priority: false });
  const r = roomByNum(t.room); if (r) { r.status = 'tozalash'; r.assignedTo = c.name; }
  notify([c.id],
    `🧹 ${t.room}-xonani (${t.floor}-qavat) tozalash kerak${t.rework ? ` — QAYTA (${t.reason})` : ''}.\n⏱ ${S().startLimit} daqiqa ichida boshlang va «Boshladim» tugmasini bosing.`,
    { taskId: t.id, buttons: [[{ text: '▶️ Boshladim', callback_data: 'start:' + t.id }]] });
}

// Bo'sh tozalovchilarga kutayotgan vazifalarni berish
function pump() {
  let any = false, progress = true;
  while (progress) {
    progress = false;
    for (const c of cleaners()) {
      if (activeTaskOf(c.id)) continue;
      const waiting = db.tasks.filter(x => x.status === 'navbatda' && (x.cleanerId === c.id || x.cleanerId === null || !isActive(staffById(x.cleanerId)) || activeTaskOf(x.cleanerId)))
        .filter(x => canServe(c, x.floor) || !cleaners().some(o => canServe(o, x.floor)))
        .sort((a, b) => (b.priority - a.priority) || ((b.cleanerId === c.id) - (a.cleanerId === c.id)) || (a.createdAt - b.createdAt));
      if (!waiting.length) continue;
      const t = waiting[0];
      if (t.cleanerId && t.cleanerId !== c.id) notify([t.cleanerId], `ℹ️ ${t.room}-xona bo'sh xodimga (${c.name}) berildi.`, { taskId: t.id });
      activate(t, c);
      progress = any = true;
    }
  }
  return any;
}

function pickInspector() {
  const pool = inspectors();
  if (!pool.length) return null;
  pool.sort((a, b) => db.tasks.filter(t => t.status === 'tekshiruvda' && t.inspectorId === a.id).length - db.tasks.filter(t => t.status === 'tekshiruvda' && t.inspectorId === b.id).length);
  return pool[0];
}

function startTask(t, u) {
  if (t.status !== 'tayinlandi') fail("Bu vazifani hozir boshlab bo'lmaydi");
  if (t.cleanerId !== u.id) fail('Bu vazifa sizga berilmagan');
  const now = Date.now();
  t.status = 'jarayonda'; t.startedAt = now;
  const r = roomByNum(t.room); if (r) r.status = 'tozalanmoqda';
  notify([u.id], `✅ ${t.room}-xona: tozalash boshlandi. ${S().cleanLimit} daqiqa ichida tugating va «Tugatdim»ni bosing.`,
    { taskId: t.id, buttons: [[{ text: '🏁 Tugatdim', callback_data: 'finish:' + t.id }]] });
  if (t.lateStart) notify(adminIds(), `ℹ️ ${u.name} ${t.room}-xonani ${Math.round((now - t.startDeadline) / MIN)} daq kechikib boshladi.`, { taskId: t.id });
  return `${t.room}-xona: tozalash boshlandi`;
}

function finishTask(t, u) {
  if (t.status !== 'jarayonda') fail("Avval «Boshladim»ni bosing");
  if (t.cleanerId !== u.id) fail('Bu vazifa sizga berilmagan');
  t.status = 'tekshiruvda'; t.finishedAt = Date.now();
  const r = roomByNum(t.room); if (r) r.status = 'tekshiruv';
  const ins = pickInspector();
  t.inspectorId = ins ? ins.id : null;
  const btn = [[{ text: '✅ Qabul', callback_data: 'ok:' + t.id }, { text: '❌ Qaytarish', callback_data: 'rej:' + t.id }]];
  if (ins) notify([ins.id], `🔍 ${t.room}-xona (${t.floor}-qavat) tozalandi (${u.name}). Borib tekshiring.`, { taskId: t.id, buttons: btn });
  else notify(adminIds(), `🔍 ${t.room}-xona tozalandi (${u.name}). Nazoratchi yo'q — o'zingiz tekshiring.`, { taskId: t.id, buttons: btn });
  pump();
  return `${t.room}-xona tekshiruvga yuborildi`;
}

function inspectTask(t, u, ok, reason) {
  if (t.status !== 'tekshiruvda') fail('Bu xona tekshiruvda emas');
  if (u.role !== 'nazoratchi' && u.role !== 'boshqaruv') fail("Ruxsat yo'q");
  const now = Date.now(), r = roomByNum(t.room);
  t.inspectorId = u.id; t.inspectedAt = now;
  if (ok) {
    t.status = 'qabul';
    if (r) { r.status = 'bosh'; r.assignedTo = null; }
    db.history.push({
      ts: now, room: t.room, floor: t.floor, cleanerId: t.cleanerId, cleaner: nameOf(t.cleanerId), inspector: u.name,
      waitMin: Math.round((t.startedAt - t.assignedAt) / MIN), cleanMin: Math.round((t.finishedAt - t.startedAt) / MIN),
      lateStart: t.lateStart, lateFinish: t.lateFinish, rework: t.rework
    });
    if (db.history.length > 5000) db.history = db.history.slice(-4000);
    notify([t.cleanerId], `👍 ${t.room}-xona nazoratdan o'tdi. Rahmat!`, { taskId: t.id });
    return `${t.room}-xona qabul qilindi — endi bo'sh`;
  }
  t.rework++; t.reason = reason || 'Nazoratchi qaytardi'; t.inspectorId = null;
  if (r) r.status = 'tozalash';
  const c = staffById(t.cleanerId);
  if (c && isActive(c) && !activeTaskOf(c.id)) activate(t, c);
  else { t.status = 'navbatda'; t.priority = true; pump(); }
  notify(adminIds(), `❌ ${t.room}-xona nazoratdan o'tmadi (${u.name}): ${t.reason}`, { level: 'warn', taskId: t.id });
  return `${t.room}-xona qayta tozalashga qaytarildi`;
}

// Har 10 soniyada muddatlarni tekshirish
function tick() {
  const now = Date.now(), st = S();
  let ch = false;
  for (const t of db.tasks) {
    if (t.status === 'tayinlandi' && !t.lateStart && now > t.startDeadline) {
      t.lateStart = true; ch = true;
      notify(adminIds(), `🚨 ${nameOf(t.cleanerId)} ${t.room}-xonani belgilangan vaqtda (${st.startLimit} daq) tozalashni boshlamadi!`, { level: 'warn', taskId: t.id });
      notify([t.cleanerId], `⏰ ${t.room}-xona: boshlash vaqti o'tdi! Darhol boshlang.`, { level: 'warn', taskId: t.id, buttons: [[{ text: '▶️ Boshladim', callback_data: 'start:' + t.id }]] });
    }
    if (t.status === 'jarayonda' && !t.lateFinish && now > t.startedAt + st.cleanLimit * MIN) {
      t.lateFinish = true; ch = true;
      notify(adminIds(), `🚨 ${nameOf(t.cleanerId)} ${t.room}-xonani ${st.cleanLimit} daqiqada tozalab bo'lmadi!`, { level: 'warn', taskId: t.id });
      notify([t.cleanerId], `⏰ ${t.room}-xona: tozalash vaqti tugadi! Iltimos, tezroq tugating.`, { level: 'warn', taskId: t.id, buttons: [[{ text: '🏁 Tugatdim', callback_data: 'finish:' + t.id }]] });
    }
    if (t.status === 'tekshiruvda' && !t.lateInspect && now > t.finishedAt + st.inspectLimit * MIN) {
      t.lateInspect = true; ch = true;
      notify([...adminIds(), t.inspectorId], `🚨 ${t.room}-xona ${st.inspectLimit} daqiqadan beri tekshirilmayapti!`, { level: 'warn', taskId: t.id });
    }
  }
  if (pump()) ch = true;
  if (ch) changed();
}

// ---------- amallar ----------
function doAction(u, b) {
  const admin = u.role === 'boshqaruv';
  const needAdmin = () => { if (!admin) fail("Ruxsat yo'q"); };
  const task = () => db.tasks.find(t => t.id === Number(b.id)) || fail('Vazifa topilmadi');
  const room = () => roomByNum(Number(b.num)) || fail('Xona topilmadi');
  let msg = null;
  switch (b.type) {
    case 'startTask': msg = startTask(task(), u); break;
    case 'finishTask': msg = finishTask(task(), u); break;
    case 'inspect': msg = inspectTask(task(), u, !!b.ok, String(b.reason || '').trim()); break;

    case 'checkout': {
      needAdmin(); const r = room();
      if (r.status !== 'band') fail('Xona band emas');
      r.guest = null; createTask(r); msg = `${r.num}-xona tozalashga yuborildi`; break;
    }
    case 'needClean': {
      needAdmin(); const r = room();
      if (r.status !== 'bosh') fail("Faqat bo'sh xonani tozalashga yuborish mumkin");
      createTask(r); msg = `${r.num}-xona tozalashga yuborildi`; break;
    }
    case 'checkin': {
      needAdmin(); const r = room();
      if (r.status !== 'bosh') fail("Xona bo'sh emas");
      r.status = 'band'; r.guest = String(b.guest || '').trim() || null; break;
    }
    case 'note': { const r = room(); r.note = String(b.note || '').trim(); break; }
    case 'addRoom': {
      needAdmin(); const num = Number(b.num), floor = Number(b.floor);
      if (!num) fail('Xona raqamini kiriting');
      if (roomByNum(num)) fail('Bunday raqamli xona allaqachon mavjud');
      db.rooms.push({ num, floor, type: String(b.roomType || '').trim() || 'Standart', status: 'bosh', guest: null, note: '', assignedTo: null });
      break;
    }
    case 'editRoom': {
      needAdmin(); const r = room(), nn = Number(b.newNum), nf = Number(b.floor);
      if (nn && nn !== r.num) {
        if (roomByNum(nn)) fail('Bunday raqamli xona allaqachon mavjud');
        db.tasks.forEach(t => { if (t.room === r.num) t.room = nn; });
        r.num = nn;
      }
      if (b.roomType) r.type = String(b.roomType).trim() || r.type;
      if (nf) { r.floor = nf; if (!db.floors.includes(nf)) { db.floors.push(nf); db.floors.sort((x, y) => x - y); } }
      break;
    }
    case 'deleteRoom': {
      needAdmin(); const r = room();
      db.tasks.forEach(t => { if (t.room === r.num && OPEN.includes(t.status)) t.status = 'bekor'; });
      db.rooms = db.rooms.filter(x => x !== r); pump(); break;
    }
    case 'addFloor': {
      needAdmin(); const f = Number(b.floor);
      if (!f) fail('Qavat raqamini kiriting');
      if (db.floors.includes(f)) fail('Bu qavat allaqachon mavjud');
      db.floors.push(f); db.floors.sort((x, y) => x - y); break;
    }
    case 'deleteFloor': {
      needAdmin(); const f = Number(b.floor);
      if (db.rooms.some(r => r.floor === f)) fail("Bu qavatda xonalar bor — avval ularni o'chiring yoki ko'chiring");
      db.floors = db.floors.filter(x => x !== f); break;
    }

    case 'reassign': {
      needAdmin(); const t = task(), c = staffById(Number(b.cleanerId));
      if (!c || c.role !== 'tozalovchi') fail('Tozalovchi topilmadi');
      if (!['navbatda', 'tayinlandi'].includes(t.status)) fail("Faqat boshlanmagan vazifani boshqaga berish mumkin");
      const old = t.cleanerId;
      if (old && old !== c.id) notify([old], `ℹ️ ${t.room}-xona sizdan olinib, ${c.name}ga berildi.`, { taskId: t.id });
      if (activeTaskOf(c.id) && activeTaskOf(c.id) !== t) { t.status = 'navbatda'; t.cleanerId = c.id; t.priority = true; notify([c.id], `📋 ${t.room}-xona navbatingizga qo'shildi (birinchi navbatda).`, { taskId: t.id }); }
      else activate(t, c);
      pump(); msg = `${t.room}-xona ${c.name}ga berildi`; break;
    }
    case 'cancelTask': {
      needAdmin(); const t = task();
      if (!OPEN.includes(t.status)) fail('Vazifa allaqachon yopilgan');
      t.status = 'bekor';
      const r = roomByNum(t.room); if (r) { r.status = 'bosh'; r.assignedTo = null; }
      if (t.cleanerId) notify([t.cleanerId], `ℹ️ ${t.room}-xona vazifasi bekor qilindi.`, { taskId: t.id });
      pump(); msg = `${t.room}-xona bo'sh deb belgilandi`; break;
    }

    case 'addStaff': {
      needAdmin();
      const name = String(b.name || '').trim(), username = String(b.username || '').trim(), password = String(b.password || '').trim();
      const role = ['tozalovchi', 'nazoratchi', 'boshqaruv'].includes(b.role) ? b.role : 'tozalovchi';
      if (!name || !username || !password) fail('Ism, login va parolni kiriting');
      if (db.staff.some(s => s.username === username)) fail('Bu login band');
      const pos = { tozalovchi: 'Farrosh', nazoratchi: 'Nazoratchi', boshqaruv: 'Administrator' }[role];
      db.staff.push({ id: db.seq.staff++, name, username, pass: hash(password), role, position: String(b.position || '').trim() || pos, phone: String(b.phone || '').trim(), active: true, floors: Array.isArray(b.floors) ? b.floors.map(Number).filter(Boolean) : [], tgCode: newCode(), tgChat: null });
      pump(); msg = `${name} qo'shildi`; break;
    }
    case 'updateStaff': {
      needAdmin(); const s = staffById(Number(b.id)) || fail('Xodim topilmadi');
      if (Array.isArray(b.floors)) s.floors = b.floors.map(Number).filter(Boolean);
      if (typeof b.active === 'boolean') {
        if (!b.active && s.id === u.id) fail("O'zingizni o'chira olmaysiz");
        s.active = b.active;
        if (!s.active) db.tasks.forEach(t => { if (t.status === 'navbatda' && t.cleanerId === s.id) t.cleanerId = null; });
      }
      if (b.password) s.pass = hash(String(b.password));
      pump(); break;
    }
    case 'deleteStaff': {
      needAdmin(); const s = staffById(Number(b.id)) || fail('Xodim topilmadi');
      if (s.id === u.id) fail("O'zingizni o'chira olmaysiz");
      db.tasks.forEach(t => {
        if (t.cleanerId === s.id && ['navbatda', 'tayinlandi'].includes(t.status)) { t.status = 'navbatda'; t.cleanerId = null; }
        if (t.inspectorId === s.id && t.status === 'tekshiruvda') t.inspectorId = null;
      });
      db.staff = db.staff.filter(x => x !== s);
      Object.keys(db.sessions).forEach(k => { if (db.sessions[k] === s.id) delete db.sessions[k]; });
      pump(); break;
    }
    case 'profile': {
      if (b.name) u.name = String(b.name).trim() || u.name;
      if (b.phone !== undefined) u.phone = String(b.phone).trim();
      if (b.password) u.pass = hash(String(b.password));
      msg = 'Saqlandi'; break;
    }
    case 'pushSubscribe': {
      const sub = b.sub;
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) fail("Noto'g'ri obuna");
      // bitta telefon faqat bitta xodimga tegishli bo'ladi
      db.staff.forEach(s => { s.push = (s.push || []).filter(x => x.endpoint !== sub.endpoint); });
      u.push.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
      if (u.push.length > 5) u.push = u.push.slice(-5);
      if (!b.silent) msg = 'Bildirishnomalar yoqildi'; break;
    }
    case 'pushUnsubscribe': u.push = (u.push || []).filter(x => x.endpoint !== b.endpoint); break;
    case 'pushTest': {
      if (!u.push || !u.push.length) fail('Bu hisobda bildirishnoma yoqilgan telefon yo\'q');
      pushSend(u, '🔔 Sinov xabari\nBildirishnomalar ishlayapti!', { urgent: true });
      msg = 'Sinov xabari yuborildi'; break;
    }
    case 'readAll': db.notifications.forEach(n => { if (n.to === u.id) n.read = true; }); break;

    case 'settings': {
      needAdmin();
      for (const k of ['startLimit', 'cleanLimit', 'inspectLimit']) if (b[k] !== undefined) {
        const v = Number(b[k]); if (!(v >= 1 && v <= 600)) fail("Vaqt 1–600 daqiqa oralig'ida bo'lsin"); db.settings[k] = v;
      }
      if (b.telegramToken !== undefined && b.telegramToken !== db.settings.telegramToken) {
        db.settings.telegramToken = String(b.telegramToken).trim(); db.settings.botUsername = '';
        setTimeout(tgLoop, 0);
      }
      msg = 'Sozlamalar saqlandi'; break;
    }
    case 'tgTest': {
      needAdmin();
      if (!u.tgChat) fail("Avval Profil sahifasidan o'zingizni Telegramga ulang");
      tgSend(u.tgChat, '✅ Sinov xabari: Telegram bildirishnomalari ishlayapti.'); msg = 'Sinov xabari yuborildi'; break;
    }
    case 'import': {
      needAdmin();
      if (Array.isArray(b.floors)) b.floors.map(Number).filter(Boolean).forEach(f => { if (!db.floors.includes(f)) db.floors.push(f); });
      db.floors.sort((x, y) => x - y);
      let nr = 0, ns = 0;
      if (Array.isArray(b.rooms)) b.rooms.forEach(x => {
        const num = Number(x.num); if (!num) return;
        let r = roomByNum(num);
        if (!r) { r = { num, floor: Number(x.floor) || 1, type: x.type || 'Standart', status: 'bosh', guest: null, note: '', assignedTo: null }; db.rooms.push(r); nr++; }
        r.floor = Number(x.floor) || r.floor; r.type = x.type || r.type; r.note = x.note || r.note || '';
        if (!db.floors.includes(r.floor)) db.floors.push(r.floor);
        if (!db.tasks.some(t => t.room === num && OPEN.includes(t.status))) {
          if (x.status === 'band') { r.status = 'band'; r.guest = x.guest || null; }
          else if (x.status === 'tozalash') createTask(r);
          else r.status = 'bosh';
        }
      });
      if (Array.isArray(b.staff)) b.staff.forEach(x => {
        if (!x.username || db.staff.some(s => s.username === x.username)) return;
        db.staff.push({ id: db.seq.staff++, name: x.name || x.username, username: String(x.username), pass: hash(x.password || x.username), role: ['tozalovchi', 'nazoratchi', 'boshqaruv'].includes(x.role) ? x.role : 'tozalovchi', position: x.position || '', phone: x.phone || '', active: true, floors: Array.isArray(x.floors) ? x.floors : [], tgCode: newCode(), tgChat: null });
        ns++;
      });
      if (Array.isArray(b.history)) b.history.forEach(h => { if (h.ts) db.history.push({ ts: h.ts, room: h.room, floor: h.floor, cleanerId: null, cleaner: h.by || '—', inspector: '—', waitMin: null, cleanMin: null, lateStart: false, lateFinish: false, rework: 0 }); });
      db.history.sort((x, y) => x.ts - y.ts);
      db.floors.sort((x, y) => x - y);
      pump(); msg = `Import qilindi: ${nr} xona, ${ns} xodim`; break;
    }
    default: fail("Noma'lum amal");
  }
  changed();
  return msg;
}

// ---------- Telegram ----------
let tgGen = 0, tgError = '';
async function tgCall(method, params, timeout = 15000) {
  const tok = db.settings.telegramToken;
  if (!tok) return null;
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}), signal: ac.signal });
    return await r.json();
  } finally { clearTimeout(tm); }
}
function tgSend(chat, text, buttons) {
  if (!db.settings.telegramToken) return;
  tgCall('sendMessage', { chat_id: chat, text, reply_markup: buttons ? { inline_keyboard: buttons } : undefined })
    .then(r => { if (r && !r.ok) console.log('Telegram:', r.description); })
    .catch(e => console.log('Telegram xato:', e.message));
}
function tgStatusText(s) {
  const t = db.tasks.find(x => x.cleanerId === s.id && ACTIVE.includes(x.status));
  if (s.role === 'tozalovchi') return t ? `Joriy vazifa: ${t.room}-xona (${t.status === 'jarayonda' ? 'tozalanmoqda' : 'boshlashni kutmoqda'})` : "Hozir vazifangiz yo'q.";
  if (s.role === 'nazoratchi') { const n = db.tasks.filter(x => x.status === 'tekshiruvda').length; return `Tekshiruvni kutayotgan xonalar: ${n} ta.`; }
  return 'Siz administrator sifatida ulangansiz.';
}
function handleUpdate(up) {
  if (up.message) {
    const chat = up.message.chat.id, txt = String(up.message.text || '').trim();
    const linked = db.staff.find(x => x.tgChat === chat);
    if (txt.startsWith('/start')) {
      const code = txt.split(/\s+/)[1], s = code && db.staff.find(x => x.tgCode === code);
      if (s) {
        db.staff.forEach(x => { if (x.tgChat === chat) x.tgChat = null; });
        s.tgChat = chat; changed();
        tgSend(chat, `✅ Salom, ${s.name}! Siz ulandingiz. Endi barcha vazifalar shu yerga keladi.`);
      } else if (linked) tgSend(chat, `Siz ${linked.name} sifatida ulangansiz.\n${tgStatusText(linked)}`);
      else tgSend(chat, "Ulash uchun dasturdagi «Profil» sahifasidagi havolani bosing.");
    } else if (linked) tgSend(chat, tgStatusText(linked));
    else tgSend(chat, "Siz hali ulanmagansiz. Dasturdagi «Profil» sahifasidagi havolani bosing.");
  }
  if (up.callback_query) {
    const q = up.callback_query, msgObj = q.message || {}, chat = msgObj.chat && msgObj.chat.id;
    const s = db.staff.find(x => x.tgChat === chat);
    const [a, id] = String(q.data || '').split(':');
    let text, ok = false;
    try {
      if (!s) fail('Siz ulanmagansiz');
      const type = { start: 'startTask', finish: 'finishTask', ok: 'inspect', rej: 'inspect' }[a];
      if (!type) fail("Noma'lum tugma");
      text = doAction(s, { type, id: Number(id), ok: a === 'ok', reason: a === 'rej' ? 'Nazoratchi qaytardi (Telegram)' : '' }) || 'Bajarildi';
      ok = true;
    } catch (e) { text = e instanceof UserError ? e.message : 'Xato'; if (!(e instanceof UserError)) console.error(e); }
    tgCall('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: !ok }).catch(() => {});
    if (chat && msgObj.message_id) tgCall('editMessageReplyMarkup', { chat_id: chat, message_id: msgObj.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
}
async function tgLoop() {
  const gen = ++tgGen;
  tgError = '';
  if (!db.settings.telegramToken) { changed(); return; }
  try {
    const me = await tgCall('getMe');
    if (!me || !me.ok) throw new Error((me && me.description) || 'Token noto\'g\'ri');
    if (gen !== tgGen) return;
    db.settings.botUsername = me.result.username;
    await tgCall('deleteWebhook').catch(() => {});
    console.log('Telegram bot ulandi: @' + me.result.username);
    changed();
  } catch (e) {
    if (gen !== tgGen) return;
    tgError = e.name === 'AbortError' ? 'Telegramga ulanib bo\'lmadi (internet?)' : e.message;
    console.log('Telegram:', tgError); changed();
    await sleep(30000); if (gen === tgGen) tgLoop();
    return;
  }
  while (gen === tgGen) {
    try {
      const r = await tgCall('getUpdates', { offset: db.tgOffset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
      if (gen !== tgGen) break;
      if (r && r.ok) {
        for (const up of r.result) { db.tgOffset = up.update_id + 1; try { handleUpdate(up); } catch (e) { console.error(e); } }
        if (r.result.length) save();
      } else await sleep(3000);
    } catch { await sleep(5000); }
  }
}

// ---------- Internet manzili (Tailscale Funnel yoki ngrok — o'zi topiladi) ----------
let publicUrl = process.env.PUBLIC_URL || null;
function tailscaleUrl() {
  return new Promise(ok => {
    require('child_process').execFile('tailscale', ['funnel', 'status'], { timeout: 4000, windowsHide: true }, (err, out) => {
      const m = !err && /https:\/\/[^\s()]+/.exec(String(out));
      ok(m && /funnel on/i.test(out) ? m[0].replace(/\/$/, '') : null);
    });
  });
}
async function detectPublicUrl() {
  if (process.env.PUBLIC_URL) return;
  let found = null;
  try { found = fs.readFileSync(path.join(__dirname, 'public-url.txt'), 'utf8').trim().replace(/\/$/, '') || null; } catch {}
  if (!found) found = await tailscaleUrl();
  if (!found) try {
    const r = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(2000) });
    const t = ((await r.json()).tunnels || []).find(x => x.public_url && x.public_url.startsWith('https://'));
    if (t) found = t.public_url;
  } catch {}
  if (found !== publicUrl) { publicUrl = found; if (found) console.log('  Internet manzili: ' + found); broadcast(); }
}
setInterval(detectPublicUrl, 20000);
setTimeout(detectPublicUrl, 3000);

// ---------- HTTP ----------
const STATIC = {
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png']
};
const clients = new Set();
function broadcast() { for (const c of clients) c.res.write('data: change\n\n'); }
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000);

function pub(s, viewer) {
  const { pass, tgCode, tgChat, push, ...rest } = s;
  const out = { ...rest, tgLinked: !!tgChat, pushCount: (push || []).length };
  if (viewer.role === 'boshqaruv' || viewer.id === s.id) out.tgCode = tgCode;
  return out;
}
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(`http://${n.address}:${PORT}`);
  return out;
}
function stateFor(u) {
  const st = db.settings, admin = u.role === 'boshqaruv';
  const closed = db.tasks.filter(t => !OPEN.includes(t.status)).slice(-100);
  return {
    serverTime: Date.now(), me: pub(u, u),
    settings: {
      startLimit: st.startLimit, cleanLimit: st.cleanLimit, inspectLimit: st.inspectLimit, botUsername: st.botUsername, hasToken: !!st.telegramToken, tgError,
      vapidPublic: st.vapid ? st.vapid.publicKey : null, publicUrl,
      ...(admin ? { telegramToken: st.telegramToken, lanUrls: lanUrls() } : {})
    },
    staff: db.staff.map(s => pub(s, u)), floors: db.floors, rooms: db.rooms,
    tasks: [...db.tasks.filter(t => OPEN.includes(t.status)), ...closed],
    history: (u.role === 'tozalovchi' ? db.history.filter(h => h.cleanerId === u.id) : db.history).slice(-500),
    notifications: db.notifications.filter(n => n.to === u.id).slice(-100)
  };
}
function userFrom(req, url) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  const id = tok && db.sessions[tok];
  return id ? staffById(id) : null;
}
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((ok, bad) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 5e6) { bad(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { bad(new Error('bad json')); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(INDEX_FILE));
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, file)));
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const s = db.staff.find(x => x.username === String(b.username || '').trim());
      if (!s || !verify(b.password || '', s.pass)) return send(res, 400, { error: "Login yoki parol noto'g'ri" });
      if (!isActive(s)) return send(res, 400, { error: 'Hisobingiz vaqtincha o\'chirilgan' });
      const tok = crypto.randomBytes(24).toString('hex');
      db.sessions[tok] = s.id; save();
      return send(res, 200, { token: tok });
    }
    const u = userFrom(req, url);
    if (url.pathname.startsWith('/api/') && !u) return send(res, 401, { error: 'Qayta kiring' });
    if (url.pathname === '/api/state') return send(res, 200, stateFor(u));
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const h = req.headers.authorization || ''; delete db.sessions[h.slice(7)]; save(); return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const c = { res, uid: u.id }; clients.add(c);
      req.on('close', () => clients.delete(c));
      return;
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const b = await readBody(req);
      try { const msg = doAction(u, b); return send(res, 200, { ok: true, msg, state: stateFor(u) }); }
      catch (e) { if (e instanceof UserError) return send(res, 200, { error: e.message }); throw e; }
    }
    send(res, 404, { error: 'Topilmadi' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server xatosi' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Mehmonxona tizimi ishga tushdi');
  console.log(`  Shu kompyuterda:  http://localhost:${PORT}`);
  lanUrls().forEach(u => console.log(`  Telefonlardan (shu Wi-Fi): ${u}`));
  console.log('  To\'xtatish uchun: Ctrl+C\n');
  save();
});
setInterval(tick, 10000);
tgLoop();
