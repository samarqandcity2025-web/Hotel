'use strict';
// Mehmonxona tizimining asosiy mantiqi: tayinlash, taymerlar, nazorat.
// Bu modul tashqi dunyoga hech narsa yubormaydi — bildirishnoma va tarix yozuvlari `out`ga yig'iladi,
// ma'lumot bazaga muvaffaqiyatli saqlangandan keyingina yuboriladi.
const crypto = require('crypto');

const MIN = 60000;
const ACTIVE = ['tayinlandi', 'jarayonda'];
const OPEN = ['navbatda', 'tayinlandi', 'jarayonda', 'tekshiruvda'];
const DEFAULT_SETTINGS = { startLimit: 10, cleanLimit: 20, inspectLimit: 15 };

class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

function hash(p, salt = crypto.randomBytes(8).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(p), salt, 32).toString('hex');
}
function verify(p, h) {
  if (!h || !h.includes(':')) return false;
  const a = Buffer.from(hash(p, h.split(':')[0])), b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seed(vapid) {
  const rooms = [
    [101, 1, 'Standart'], [102, 1, 'Standart'], [103, 1, 'Deluxe'], [104, 1, 'Deluxe'],
    [201, 2, 'Suite'], [202, 2, 'Standart'], [203, 2, 'Standart'], [204, 2, 'Deluxe']
  ].map(([num, floor, type]) => ({ num, floor, type, status: 'bosh', guest: null, note: '', assignedTo: null }));
  return {
    settings: { ...DEFAULT_SETTINGS, vapid },
    staff: [{ id: 1, username: '4455', pass: hash('4455'), name: 'Administrator', role: 'boshqaruv', position: 'Administrator', phone: '', active: true, floors: [], push: [] }],
    floors: [1, 2], rooms, tasks: [], sessions: {}, seq: { staff: 2, task: 1 }
  };
}
function normalize(db) {
  db.settings = { ...DEFAULT_SETTINGS, ...db.settings };
  db.staff.forEach(s => { if (!Array.isArray(s.push)) s.push = []; if (!Array.isArray(s.floors)) s.floors = []; });
  db.sessions = db.sessions || {};
  db.tasks = db.tasks || [];
  return db;
}
const newOut = () => ({ notifs: [], history: [], rawPush: [] });

// Eng yaqin muddat — shu vaqtgacha taymer tekshiruvi kerak emas (bazaga ortiqcha so'rov yubormaslik uchun)
function nextDue(db) {
  const st = db.settings;
  let due = Number.MAX_SAFE_INTEGER;
  for (const t of db.tasks) {
    if (t.status === 'tayinlandi' && !t.lateStart) due = Math.min(due, t.startDeadline);
    if (t.status === 'jarayonda' && !t.lateFinish) due = Math.min(due, t.startedAt + st.cleanLimit * MIN);
    if (t.status === 'tekshiruvda' && !t.lateInspect) due = Math.min(due, t.finishedAt + st.inspectLimit * MIN);
  }
  return due;
}

function engine(db, out) {
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
  const today = () => new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10); // Toshkent vaqti
  const doneToday = cid => { const s = staffById(cid); return s && s.doneDate === today() ? s.doneCount || 0 : 0; };

  function notify(userIds, text, { level = 'info', taskId = null } = {}) {
    const ts = Date.now();
    [...new Set(userIds.filter(Boolean))].forEach(to => out.notifs.push({ to, text, level, taskId, ts }));
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
      notify([c.id], `📋 ${t.room}-xona navbatingizga qo'shildi\nHozirgi ishingizdan keyin boshlaysiz (~${mins} daq).`, { taskId: t.id });
    }
  }

  function activate(t, c) {
    const now = Date.now();
    Object.assign(t, { cleanerId: c.id, status: 'tayinlandi', assignedAt: now, startDeadline: now + S().startLimit * MIN, startedAt: null, finishedAt: null, lateStart: false, lateFinish: false, priority: false });
    const r = roomByNum(t.room); if (r) { r.status = 'tozalash'; r.assignedTo = c.name; }
    notify([c.id], `🧹 ${t.room}-xonani tozalash kerak (${t.floor}-qavat)${t.rework ? ` — QAYTA: ${t.reason}` : ''}\n⏱ ${S().startLimit} daqiqa ichida boshlang va «Boshladim»ni bosing.`, { level: 'task', taskId: t.id });
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
    const load = s => db.tasks.filter(t => t.status === 'tekshiruvda' && t.inspectorId === s.id).length;
    return pool.sort((a, b) => load(a) - load(b))[0];
  }

  function startTask(t, u) {
    if (t.status !== 'tayinlandi') fail("Bu vazifani hozir boshlab bo'lmaydi");
    if (t.cleanerId !== u.id) fail('Bu vazifa sizga berilmagan');
    const now = Date.now();
    t.status = 'jarayonda'; t.startedAt = now;
    const r = roomByNum(t.room); if (r) r.status = 'tozalanmoqda';
    if (t.lateStart) notify(adminIds(), `ℹ️ ${u.name} ${t.room}-xonani ${Math.round((now - t.startDeadline) / MIN)} daq kechikib boshladi.`, { taskId: t.id });
    return `${t.room}-xona: tozalash boshlandi. ${S().cleanLimit} daqiqa vaqtingiz bor`;
  }

  function finishTask(t, u) {
    if (t.status !== 'jarayonda') fail('Avval «Boshladim»ni bosing');
    if (t.cleanerId !== u.id) fail('Bu vazifa sizga berilmagan');
    t.status = 'tekshiruvda'; t.finishedAt = Date.now();
    const r = roomByNum(t.room); if (r) r.status = 'tekshiruv';
    const ins = pickInspector();
    t.inspectorId = ins ? ins.id : null;
    if (ins) notify([ins.id], `🔍 ${t.room}-xona tozalandi — borib tekshiring\n${t.floor}-qavat · tozaladi: ${u.name}`, { level: 'task', taskId: t.id });
    else notify(adminIds(), `🔍 ${t.room}-xona tozalandi (${u.name})\nNazoratchi yo'q — o'zingiz tekshiring.`, { level: 'task', taskId: t.id });
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
      const c = staffById(t.cleanerId);
      if (c) { if (c.doneDate !== today()) { c.doneDate = today(); c.doneCount = 0; } c.doneCount++; }
      out.history.push({
        ts: now, room: t.room, floor: t.floor, cleanerId: t.cleanerId, cleaner: nameOf(t.cleanerId), inspector: u.name,
        waitMin: Math.round((t.startedAt - t.assignedAt) / MIN), cleanMin: Math.round((t.finishedAt - t.startedAt) / MIN),
        lateStart: t.lateStart, lateFinish: t.lateFinish, rework: t.rework
      });
      notify([t.cleanerId], `👍 ${t.room}-xona nazoratdan o'tdi. Rahmat!`, { taskId: t.id });
      return `${t.room}-xona qabul qilindi — endi bo'sh`;
    }
    t.rework++; t.reason = reason || 'Nazoratchi qaytardi'; t.inspectorId = null;
    if (r) r.status = 'tozalash';
    const c = staffById(t.cleanerId);
    if (c && isActive(c) && !activeTaskOf(c.id)) activate(t, c);
    else { t.status = 'navbatda'; t.priority = true; pump(); }
    notify(adminIds(), `❌ ${t.room}-xona nazoratdan o'tmadi (${u.name})\n${t.reason}`, { level: 'warn', taskId: t.id });
    return `${t.room}-xona qayta tozalashga qaytarildi`;
  }

  // Muddatlarni tekshirish — har so'rovda va har daqiqada (cron) chaqiriladi
  function tick() {
    const now = Date.now(), st = S();
    let ch = false;
    for (const t of db.tasks) {
      if (t.status === 'tayinlandi' && !t.lateStart && now > t.startDeadline) {
        t.lateStart = true; ch = true;
        notify(adminIds(), `🚨 ${nameOf(t.cleanerId)} ${t.room}-xonani vaqtida boshlamadi!\n${st.startLimit} daqiqa o'tdi, hali «Boshladim» bosilmagan.`, { level: 'warn', taskId: t.id });
        notify([t.cleanerId], `⏰ ${t.room}-xona: boshlash vaqti o'tdi!\nDarhol boshlang va «Boshladim»ni bosing.`, { level: 'warn', taskId: t.id });
      }
      if (t.status === 'jarayonda' && !t.lateFinish && now > t.startedAt + st.cleanLimit * MIN) {
        t.lateFinish = true; ch = true;
        notify(adminIds(), `🚨 ${nameOf(t.cleanerId)} ${t.room}-xonani ${st.cleanLimit} daqiqada tozalab bo'lmadi!`, { level: 'warn', taskId: t.id });
        notify([t.cleanerId], `⏰ ${t.room}-xona: tozalash vaqti tugadi!\nIltimos, tezroq tugating.`, { level: 'warn', taskId: t.id });
      }
      if (t.status === 'tekshiruvda' && !t.lateInspect && now > t.finishedAt + st.inspectLimit * MIN) {
        t.lateInspect = true; ch = true;
        notify([...adminIds(), t.inspectorId], `🚨 ${t.room}-xona ${st.inspectLimit} daqiqadan beri tekshirilmayapti!`, { level: 'warn', taskId: t.id });
      }
    }
    if (pump()) ch = true;
    // yopilgan eski vazifalarni tozalash
    const closed = db.tasks.filter(t => !OPEN.includes(t.status));
    if (closed.length > 300) { const drop = new Set(closed.slice(0, closed.length - 200)); db.tasks = db.tasks.filter(t => !drop.has(t)); ch = true; }
    return ch;
  }

  function doAction(u, b) {
    const admin = u.role === 'boshqaruv';
    const needAdmin = () => { if (!admin) fail("Ruxsat yo'q"); };
    const task = () => db.tasks.find(t => t.id === Number(b.id)) || fail('Vazifa topilmadi');
    const room = () => roomByNum(Number(b.num)) || fail('Xona topilmadi');
    const parseFloors = v => Array.isArray(v) ? v.map(Number).filter(Boolean) : [];
    switch (b.type) {
      case 'startTask': return startTask(task(), u);
      case 'finishTask': return finishTask(task(), u);
      case 'inspect': return inspectTask(task(), u, !!b.ok, String(b.reason || '').trim());

      case 'checkout': {
        needAdmin(); const r = room();
        if (r.status !== 'band') fail('Xona band emas');
        r.guest = null; createTask(r); return `${r.num}-xona tozalashga yuborildi`;
      }
      case 'needClean': {
        needAdmin(); const r = room();
        if (r.status !== 'bosh') fail("Faqat bo'sh xonani tozalashga yuborish mumkin");
        createTask(r); return `${r.num}-xona tozalashga yuborildi`;
      }
      case 'checkin': {
        needAdmin(); const r = room();
        if (r.status !== 'bosh') fail("Xona bo'sh emas");
        r.status = 'band'; r.guest = String(b.guest || '').trim() || null; return null;
      }
      case 'note': { const r = room(); r.note = String(b.note || '').trim(); return null; }
      case 'addRoom': {
        needAdmin(); const num = Number(b.num), floor = Number(b.floor);
        if (!num) fail('Xona raqamini kiriting');
        if (roomByNum(num)) fail('Bunday raqamli xona allaqachon mavjud');
        db.rooms.push({ num, floor, type: String(b.roomType || '').trim() || 'Standart', status: 'bosh', guest: null, note: '', assignedTo: null });
        return null;
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
        return null;
      }
      case 'deleteRoom': {
        needAdmin(); const r = room();
        db.tasks.forEach(t => { if (t.room === r.num && OPEN.includes(t.status)) t.status = 'bekor'; });
        db.rooms = db.rooms.filter(x => x !== r); pump(); return null;
      }
      case 'addFloor': {
        needAdmin(); const f = Number(b.floor);
        if (!f) fail('Qavat raqamini kiriting');
        if (db.floors.includes(f)) fail('Bu qavat allaqachon mavjud');
        db.floors.push(f); db.floors.sort((x, y) => x - y); return null;
      }
      case 'deleteFloor': {
        needAdmin(); const f = Number(b.floor);
        if (db.rooms.some(r => r.floor === f)) fail("Bu qavatda xonalar bor — avval ularni o'chiring yoki ko'chiring");
        db.floors = db.floors.filter(x => x !== f); return null;
      }

      case 'reassign': {
        needAdmin(); const t = task(), c = staffById(Number(b.cleanerId));
        if (!c || c.role !== 'tozalovchi') fail('Tozalovchi topilmadi');
        if (!['navbatda', 'tayinlandi'].includes(t.status)) fail('Faqat boshlanmagan vazifani boshqaga berish mumkin');
        const old = t.cleanerId;
        if (old && old !== c.id) notify([old], `ℹ️ ${t.room}-xona sizdan olinib, ${c.name}ga berildi.`, { taskId: t.id });
        const cur = activeTaskOf(c.id);
        if (cur && cur !== t) { t.status = 'navbatda'; t.cleanerId = c.id; t.priority = true; notify([c.id], `📋 ${t.room}-xona navbatingizga qo'shildi (birinchi navbatda).`, { taskId: t.id }); }
        else activate(t, c);
        pump(); return `${t.room}-xona ${c.name}ga berildi`;
      }
      case 'cancelTask': {
        needAdmin(); const t = task();
        if (!OPEN.includes(t.status)) fail('Vazifa allaqachon yopilgan');
        t.status = 'bekor';
        const r = roomByNum(t.room); if (r) { r.status = 'bosh'; r.assignedTo = null; }
        if (t.cleanerId) notify([t.cleanerId], `ℹ️ ${t.room}-xona vazifasi bekor qilindi.`, { taskId: t.id });
        pump(); return `${t.room}-xona bo'sh deb belgilandi`;
      }

      case 'addStaff': {
        needAdmin();
        const name = String(b.name || '').trim(), username = String(b.username || '').trim(), password = String(b.password || '').trim();
        const role = ['tozalovchi', 'nazoratchi', 'boshqaruv'].includes(b.role) ? b.role : 'tozalovchi';
        if (!name || !username || !password) fail('Ism, login va parolni kiriting');
        if (db.staff.some(s => s.username === username)) fail('Bu login band');
        const pos = { tozalovchi: 'Farrosh', nazoratchi: 'Nazoratchi', boshqaruv: 'Administrator' }[role];
        db.staff.push({ id: db.seq.staff++, name, username, pass: hash(password), role, position: String(b.position || '').trim() || pos, phone: String(b.phone || '').trim(), active: true, floors: parseFloors(b.floors), push: [] });
        pump(); return `${name} qo'shildi`;
      }
      case 'updateStaff': {
        needAdmin(); const s = staffById(Number(b.id)) || fail('Xodim topilmadi');
        if (Array.isArray(b.floors)) s.floors = parseFloors(b.floors);
        if (typeof b.active === 'boolean') {
          if (!b.active && s.id === u.id) fail("O'zingizni o'chira olmaysiz");
          s.active = b.active;
          if (!s.active) db.tasks.forEach(t => { if (t.status === 'navbatda' && t.cleanerId === s.id) t.cleanerId = null; });
        }
        if (b.password) s.pass = hash(String(b.password));
        pump(); return b.password ? 'Parol o\'zgartirildi' : null;
      }
      case 'deleteStaff': {
        needAdmin(); const s = staffById(Number(b.id)) || fail('Xodim topilmadi');
        if (s.id === u.id) fail("O'zingizni o'chira olmaysiz");
        db.tasks.forEach(t => {
          if (t.cleanerId === s.id && ['navbatda', 'tayinlandi'].includes(t.status)) { t.status = 'navbatda'; t.cleanerId = null; }
          if (t.inspectorId === s.id && t.status === 'tekshiruvda') t.inspectorId = null;
        });
        db.staff = db.staff.filter(x => x !== s);
        Object.keys(db.sessions).forEach(k => { if (db.sessions[k].id === s.id) delete db.sessions[k]; });
        pump(); return `${s.name} o'chirildi`;
      }
      case 'profile': {
        if (b.name) u.name = String(b.name).trim() || u.name;
        if (b.phone !== undefined) u.phone = String(b.phone).trim();
        if (b.password) u.pass = hash(String(b.password));
        return 'Saqlandi';
      }
      case 'settings': {
        needAdmin();
        for (const k of ['startLimit', 'cleanLimit', 'inspectLimit']) if (b[k] !== undefined) {
          const v = Number(b[k]); if (!(v >= 1 && v <= 600)) fail("Vaqt 1–600 daqiqa oralig'ida bo'lsin"); db.settings[k] = v;
        }
        return 'Sozlamalar saqlandi';
      }

      case 'pushSubscribe': {
        const sub = b.sub;
        if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) fail("Noto'g'ri obuna");
        // bitta telefon faqat bitta xodimga tegishli
        db.staff.forEach(s => { s.push = s.push.filter(x => x.endpoint !== sub.endpoint); });
        u.push.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
        if (u.push.length > 5) u.push = u.push.slice(-5);
        return b.silent ? null : 'Bildirishnomalar yoqildi';
      }
      case 'pushUnsubscribe': u.push = u.push.filter(x => x.endpoint !== b.endpoint); return null;
      case 'pushTest': {
        if (!u.push.length) fail("Bu hisobda bildirishnoma yoqilgan telefon yo'q");
        out.rawPush.push({ to: u.id, text: '🔔 Sinov xabari\nBildirishnomalar ishlayapti!', level: 'warn' });
        return 'Sinov xabari yuborildi';
      }

      case 'import': {
        needAdmin();
        if (Array.isArray(b.floors)) b.floors.map(Number).filter(Boolean).forEach(f => { if (!db.floors.includes(f)) db.floors.push(f); });
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
          db.staff.push({ id: db.seq.staff++, name: x.name || x.username, username: String(x.username), pass: hash(x.password || x.username), role: ['tozalovchi', 'nazoratchi', 'boshqaruv'].includes(x.role) ? x.role : 'tozalovchi', position: x.position || '', phone: x.phone || '', active: true, floors: parseFloors(x.floors), push: [] });
          ns++;
        });
        if (Array.isArray(b.history)) b.history.slice(-2000).forEach(h => { if (h.ts) out.history.push({ ts: h.ts, room: h.room, floor: h.floor, cleanerId: null, cleaner: h.by || '—', inspector: '—', waitMin: null, cleanMin: null, lateStart: false, lateFinish: false, rework: 0 }); });
        db.floors.sort((x, y) => x - y);
        pump(); return `Import qilindi: ${nr} xona, ${ns} xodim`;
      }
      default: fail("Noma'lum amal");
    }
  }

  return { doAction, tick };
}

// Mijozga yuboriladigan ma'lumot (parollar va push kalitlarisiz)
function pub(s) {
  const { pass, push, ...rest } = s;
  return { ...rest, pushCount: (push || []).length };
}
function stateFor(u, db, ver, history, notifications) {
  const st = db.settings;
  const closed = db.tasks.filter(t => !OPEN.includes(t.status)).slice(-100);
  return {
    ver, serverTime: Date.now(), me: pub(u),
    settings: { startLimit: st.startLimit, cleanLimit: st.cleanLimit, inspectLimit: st.inspectLimit, vapidPublic: st.vapid ? st.vapid.publicKey : null },
    staff: db.staff.map(pub), floors: db.floors, rooms: db.rooms,
    tasks: [...db.tasks.filter(t => OPEN.includes(t.status)), ...closed],
    history, notifications
  };
}

module.exports = { MIN, OPEN, UserError, fail, hash, verify, seed, normalize, newOut, nextDue, engine, stateFor };
