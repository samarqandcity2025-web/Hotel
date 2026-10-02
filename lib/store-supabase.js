'use strict';
// Supabase (Postgres) — PostgREST orqali, qo'shimcha kutubxonasiz.
// Jadvallar: kv (asosiy holat, versiya bilan), history, notifications. supabase.sql ga qarang.
module.exports = function supabaseStore(url, key) {
  const base = url.replace(/\/$/, '') + '/rest/v1';
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key; // eski JWT kalitlar uchun

  async function rq(method, path, body, prefer) {
    const r = await fetch(base + path, {
      method, headers: prefer ? { ...headers, Prefer: prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]}: ${r.status} ${await r.text()}`);
    return r.status === 204 || prefer === 'return=minimal' ? null : r.json();
  }

  return {
    name: 'supabase',
    async head() {
      const rows = await rq('GET', '/kv?key=eq.core&select=ver,next_due');
      return rows[0] ? { ver: Number(rows[0].ver), nextDue: Number(rows[0].next_due) } : null;
    },
    async loadCore() {
      const rows = await rq('GET', '/kv?key=eq.core&select=value,ver');
      return rows[0] ? { db: rows[0].value, ver: Number(rows[0].ver) } : null;
    },
    // Versiya mos kelsagina yozadi (bir vaqtdagi ikki o'zgarish bir-birini o'chirmasligi uchun)
    async saveCore(db, ver, nextDue) {
      if (ver == null) {
        const rows = await rq('POST', '/kv', { key: 'core', value: db, ver: 1, next_due: nextDue }, 'resolution=ignore-duplicates,return=representation');
        return rows.length === 1;
      }
      const rows = await rq('PATCH', `/kv?key=eq.core&ver=eq.${ver}`, { value: db, ver: ver + 1, next_due: nextDue }, 'return=representation');
      return rows.length === 1;
    },
    async addHistory(list) {
      await rq('POST', '/history', list.map(h => ({ ts: h.ts, cleaner_id: h.cleanerId, data: h })), 'return=minimal');
    },
    async getHistory(cleanerId, limit = 500) {
      const rows = await rq('GET', `/history?select=data&order=id.desc&limit=${limit}${cleanerId ? `&cleaner_id=eq.${cleanerId}` : ''}`);
      return rows.map(r => r.data).reverse();
    },
    async addNotifications(list) {
      await rq('POST', '/notifications', list.map(n => ({ to_id: n.to, ts: n.ts, level: n.level, text: n.text, task_id: n.taskId })), 'return=minimal');
    },
    async getNotifications(uid, limit = 100) {
      const rows = await rq('GET', `/notifications?to_id=eq.${uid}&select=id,ts,level,text,task_id,read&order=id.desc&limit=${limit}`);
      return rows.map(r => ({ id: Number(r.id), ts: Number(r.ts), level: r.level, text: r.text, taskId: r.task_id, read: r.read })).reverse();
    },
    async markRead(uid) {
      await rq('PATCH', `/notifications?to_id=eq.${uid}&read=eq.false`, { read: true }, 'return=minimal');
    },
    async cleanup() {
      const old = Date.now() - 30 * 24 * 3600000;
      await rq('DELETE', `/notifications?ts=lt.${old}`, undefined, 'return=minimal');
    }
  };
};
