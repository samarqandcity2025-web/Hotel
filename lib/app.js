'use strict';
// API: /api/login, /api/logout, /api/state, /api/action, /api/tick
// Vercel'da ham (api/index.js), kompyuterda ham (server.js) shu kod ishlaydi.
const crypto = require('crypto');
const L = require('./logic');

let webpush = null;
try { webpush = require('web-push'); } catch {}

function makeStore() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (url && key) return require('./store-supabase')(url, key);
  if (process.env.VERCEL) throw new Error('SUPABASE_URL va SUPABASE_SERVICE_ROLE_KEY sozlanmagan (Vercel → Settings → Environment Variables)');
  return require('./store-file')(process.env.DATA_FILE || require('path').join(__dirname, '..', 'data.json'));
}
let store = null;
const getStore = () => store || (store = makeStore());

// ---------- holatni o'qish/yozish ----------
async function load() {
  const st = getStore();
  let c = await st.loadCore();
  if (!c) {
    const vapid = webpush ? webpush.generateVAPIDKeys() : null;
    const db = L.seed(vapid);
    await st.saveCore(db, null, L.nextDue(db)); // ikkinchi so'rov ham yaratsa — birinchisi qoladi
    c = await st.loadCore();
  }
  return { db: L.normalize(c.db), ver: c.ver };
}

// O'zgartirish: muddatlar tekshiriladi, fn bajariladi, versiya mos kelsa saqlanadi; aks holda qaytadan.
async function mutate(fn, { always = false } = {}) {
  for (let i = 0; i < 6; i++) {
    const { db, ver } = await load();
    const out = L.newOut();
    const eng = L.engine(db, out);
    const ticked = eng.tick();
    const res = fn ? fn(db, eng, out) : undefined; // UserError bo'lsa — yuqoriga chiqadi
    if (!fn && !ticked && !always) return { db, ver, res };
    if (await getStore().saveCore(db, ver, L.nextDue(db))) {
      await deliver(db, out);
      return { db, ver: ver + 1, res };
    }
    await new Promise(r => setTimeout(r, 40 + Math.random() * 120));
  }
  throw new Error("Juda ko'p bir vaqtdagi o'zgarish — qayta urinib ko'ring");
}

// Saqlangandan keyin: bildirishnomalarni bazaga yozish va telefonlarga push yuborish
async function deliver(db, out) {
  const st = getStore(), jobs = [], dead = [];
  if (out.history.length) jobs.push(st.addHistory(out.history));
  if (out.notifs.length) jobs.push(st.addNotifications(out.notifs));
  if (webpush && db.settings.vapid) {
    webpush.setVapidDetails('mailto:admin@mehmonxona.uz', db.settings.vapid.publicKey, db.settings.vapid.privateKey);
    for (const n of [...out.notifs, ...out.rawPush]) {
      const s = db.staff.find(x => x.id === n.to);
      if (!s || !s.push.length) continue;
      const lines = n.text.split('\n');
      const payload = JSON.stringify({ title: lines[0], body: lines.slice(1).join('\n'), urgent: n.level === 'warn' || n.level === 'task', tag: n.taskId ? 'task-' + n.taskId : 'm' + n.ts });
      for (const sub of s.push) jobs.push(webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high', timeout: 6000 }).catch(e => {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
        else console.log('Push xato:', e.statusCode || '', e.body || e.message);
      }));
    }
  }
  const results = await Promise.allSettled(jobs);
  results.forEach(r => { if (r.status === 'rejected') console.error(r.reason); });
  if (dead.length) await mutate(d => { d.staff.forEach(s => { s.push = s.push.filter(x => !dead.includes(x.endpoint)); }); }).catch(() => {});
}

// ---------- yordamchilar ----------
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? (req.body ? JSON.parse(req.body) : {}) : (req.body || {});
  let d = '';
  for await (const c of req) { d += c; if (d.length > 5e6) throw new Error('too big'); }
  return d ? JSON.parse(d) : {};
}
const tokenOf = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };
function userOf(db, tok) {
  const s = tok && db.sessions[tok];
  const u = s && db.staff.find(x => x.id === s.id);
  return u && u.active !== false ? u : null;
}
async function fullState(u, db, ver) {
  const st = getStore();
  const [history, notifications] = await Promise.all([
    st.getHistory(u.role === 'tozalovchi' ? u.id : null, 500),
    st.getNotifications(u.id, 100)
  ]);
  return L.stateFor(u, db, ver, history, notifications);
}

// ---------- marshrutlar ----------
async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const route = (url.searchParams.get('route') || url.pathname.replace(/^\/api\/?/, '')).replace(/\/$/, '');
  try {
    if (route === 'login' && req.method === 'POST') {
      const b = await readBody(req);
      const tok = crypto.randomBytes(24).toString('hex');
      await mutate(db => {
        const s = db.staff.find(x => x.username === String(b.username || '').trim());
        if (!s || !L.verify(b.password || '', s.pass)) L.fail("Login yoki parol noto'g'ri");
        if (s.active === false) L.fail("Hisobingiz vaqtincha o'chirilgan");
        db.sessions[tok] = { id: s.id, ts: Date.now() };
        const keys = Object.keys(db.sessions);
        if (keys.length > 300) keys.sort((a, b2) => db.sessions[a].ts - db.sessions[b2].ts).slice(0, keys.length - 300).forEach(k => delete db.sessions[k]);
      });
      return send(res, 200, { token: tok });
    }

    if (route === 'tick') {
      // cron-job.org har daqiqada chaqiradi — hech kim ilovani ochmagan bo'lsa ham taymerlar ishlaydi
      const secret = process.env.CRON_SECRET;
      const given = url.searchParams.get('key') || (req.headers.authorization || '').replace('Bearer ', '');
      if (secret && given !== secret) return send(res, 401, { error: 'key' });
      const h = await getStore().head();
      const due = !h || Date.now() >= h.nextDue;
      if (due) await mutate(null);
      if (Math.random() < 0.02) await getStore().cleanup().catch(() => {});
      return send(res, 200, { ok: true, checked: due });
    }

    const tok = tokenOf(req);
    if (!tok) return send(res, 401, { error: 'Qayta kiring' });

    if (route === 'state') {
      const known = Number(url.searchParams.get('v')) || 0;
      const h = await getStore().head();
      // tez yo'l: hech narsa o'zgarmagan va hech qanday muddat kelmagan
      if (h && known === h.ver && Date.now() < h.nextDue) return send(res, 200, { same: true, ver: h.ver });
      const { db, ver } = await mutate(null);
      const u = userOf(db, tok);
      if (!u) return send(res, 401, { error: 'Qayta kiring' });
      if (known === ver) return send(res, 200, { same: true, ver });
      return send(res, 200, await fullState(u, db, ver));
    }

    if (route === 'logout' && req.method === 'POST') {
      await mutate(db => { delete db.sessions[tok]; }).catch(() => {});
      return send(res, 200, { ok: true });
    }

    if (route === 'action' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.type === 'readAll') {
        const { db, ver } = await mutate(null);
        const u = userOf(db, tok); if (!u) return send(res, 401, { error: 'Qayta kiring' });
        await getStore().markRead(u.id);
        return send(res, 200, { ok: true, state: await fullState(u, db, ver) });
      }
      try {
        let me = null;
        const { db, ver, res: msg } = await mutate((db, eng) => {
          const u = userOf(db, tok);
          if (!u) throw Object.assign(new Error('auth'), { auth: true });
          me = u.id;
          return eng.doAction(u, b);
        });
        const u = db.staff.find(x => x.id === me);
        return send(res, 200, { ok: true, msg, state: await fullState(u, db, ver) });
      } catch (e) {
        if (e.auth) return send(res, 401, { error: 'Qayta kiring' });
        if (e instanceof L.UserError) return send(res, 200, { error: e.message });
        throw e;
      }
    }
    send(res, 404, { error: 'Topilmadi' });
  } catch (e) {
    if (e instanceof L.UserError) return send(res, 400, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server xatosi: ' + e.message });
  }
}

module.exports = { handler };
