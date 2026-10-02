'use strict';
// Kompyuterda sinash uchun: hamma narsa bitta JSON faylda
const fs = require('fs');
const clone = o => JSON.parse(JSON.stringify(o));

module.exports = function fileStore(file) {
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { d = null; }
  if (!d || !('core' in d)) d = { core: null, ver: 0, nextDue: 0, history: [], notifications: [], nseq: 1 };
  const save = () => {
    const json = JSON.stringify(d);
    try { fs.writeFileSync(file + '.tmp', json); fs.renameSync(file + '.tmp', file); } catch { fs.writeFileSync(file, json); }
  };
  return {
    name: 'file',
    async head() { return d.core ? { ver: d.ver, nextDue: d.nextDue } : null; },
    async loadCore() { return d.core ? { db: clone(d.core), ver: d.ver } : null; },
    async saveCore(db, ver, nextDue) {
      if ((ver == null && d.core) || (ver != null && ver !== d.ver)) return false;
      d.core = clone(db); d.ver = (ver || 0) + 1; d.nextDue = nextDue; save(); return true;
    },
    async addHistory(list) { d.history.push(...list); if (d.history.length > 5000) d.history = d.history.slice(-4000); save(); },
    async getHistory(cleanerId, limit = 500) { return (cleanerId ? d.history.filter(h => h.cleanerId === cleanerId) : d.history).slice(-limit); },
    async addNotifications(list) {
      list.forEach(n => d.notifications.push({ id: d.nseq++, to: n.to, ts: n.ts, level: n.level, text: n.text, taskId: n.taskId, read: false }));
      if (d.notifications.length > 3000) d.notifications = d.notifications.slice(-2000);
      save();
    },
    async getNotifications(uid, limit = 100) { return d.notifications.filter(n => n.to === uid).slice(-limit).map(({ to, ...n }) => n); },
    async markRead(uid) { d.notifications.forEach(n => { if (n.to === uid) n.read = true; }); save(); },
    async cleanup() {}
  };
};
