/* Play Together backend for Farx Builder (Vercel Function + Upstash Redis REST, no npm packages).
   Every room is one Redis stream: all players post their changes into it and read it back in the same order,
   so everyone applies the same events in the same order. Presence (positions, selections) lives in a hash. */
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 12, MAXLEN = 5000, MAX_PLAYERS = 8, STALE = 15000, PAGE = 300;
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function redis(cmds) {
  const r = await fetch(RURL + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + RTOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('Redis ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const out = await r.json();
  for (const x of out) if (x && x.error) throw new Error('Redis: ' + x.error);
  return out.map((x) => x.result);
}
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
const newCode = () => Array.from({ length: 6 }, () => CODE_CH[Math.floor(Math.random() * CODE_CH.length)]).join('');
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
function presence(flat, now) {
  const out = {};
  for (let i = 0; flat && i < flat.length; i += 2) { const p = parse(flat[i + 1]); if (p && now - p.ts < STALE) out[flat[i]] = p; }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!RURL || !RTOKEN) return res.status(500).json({ error: 'Redis is not connected. In Vercel: Storage > Upstash Redis > Connect to this project, then redeploy.' });
  let b = req.body; if (typeof b === 'string') b = parse(b); b = b || {};
  const now = Date.now(), code = cleanCode(b.code), k = (s) => 'ft:' + code + ':' + s;
  try {
    if (b.a === 'create') {
      for (let i = 0; i < 6; i++) {
        const c = newCode(), kk = (s) => 'ft:' + c + ':' + s, minSlot = Math.max(1, Math.min(1000, b.minSlot | 0));
        const [ok] = await redis([['SET', kk('m'), '{}', 'NX', 'EX', TTL]]);
        if (ok !== 'OK') continue;
        const [, slot] = await redis([['SET', kk('n'), minSlot - 1, 'EX', TTL], ['INCR', kk('n')]]);
        const meta = { owner: 'p' + slot, settings: { edit: true, sim: true }, created: now };
        await redis([['SET', kk('m'), JSON.stringify(meta), 'EX', TTL]]);
        return res.json({ code: c, pid: 'p' + slot, slot, meta });
      }
      return res.status(503).json({ error: 'Could not reserve a room code, try again' });
    }
    if (code.length < 4) return res.status(400).json({ error: 'Missing room code' });

    if (b.a === 'join') {
      const [m, pres] = await redis([['GET', k('m')], ['HGETALL', k('p')]]);
      if (!m) return res.status(404).json({ error: 'Room ' + code + ' not found (rooms expire after 12 hours)' });
      const players = presence(pres, now);
      if (Object.keys(players).length >= MAX_PLAYERS) return res.status(409).json({ error: 'The room is full' });
      const [slot, snap] = await redis([['INCR', k('n')], ['GET', k('snap')], ['EXPIRE', k('n'), TTL]]);
      return res.json({ pid: 'p' + slot, slot, meta: parse(m), snap: parse(snap), players });
    }

    const pid = String(b.pid || '').slice(0, 12); if (!/^p\d+$/.test(pid)) return res.status(400).json({ error: 'Bad player id' });

    if (b.a === 'snap') { const [snap] = await redis([['GET', k('snap')]]); return res.json({ snap: parse(snap) }); }
    if (b.a === 'leave') { await redis([['HDEL', k('p'), pid]]); return res.json({ ok: true }); }

    if (b.a === 'sync') {
      const cmds = [], out = Array.isArray(b.out) ? b.out.slice(0, 100) : [];
      if (b.touch || b.settings) cmds.push(['GET', k('m')]);
      for (const e of out) cmds.push(['XADD', k('s'), 'MAXLEN', '~', MAXLEN, '*', 'd', JSON.stringify({ ...e, o: pid })]);
      if (b.pres) cmds.push(['HSET', k('p'), pid, JSON.stringify({ ...b.pres, ts: now })]);
      if (b.snap) cmds.push(['SET', k('snap'), JSON.stringify(b.snap), 'EX', TTL]);
      cmds.push(['XRANGE', k('s'), b.after ? '(' + b.after : '-', '+', 'COUNT', PAGE], ['HGETALL', k('p')]);
      if (b.touch) for (const s of ['m', 'n', 's', 'p', 'snap']) cmds.push(['EXPIRE', k(s), TTL]);
      const r = await redis(cmds);
      let meta;
      if (b.touch || b.settings) {
        meta = parse(r[0]);
        if (!meta) return res.status(404).json({ error: 'Room ' + code + ' not found (rooms expire after 12 hours)' });
        if (b.settings && meta.owner === pid) { meta.settings = { ...meta.settings, ...b.settings }; await redis([['SET', k('m'), JSON.stringify(meta), 'EX', TTL]]); }
      }
      const at = cmds.findIndex((c) => c[0] === 'XRANGE'), ev = (r[at] || []).map(([id, f]) => [id, parse(f[1])]).filter((x) => x[1]);
      return res.json({ ev, more: ev.length >= PAGE, pres: presence(r[at + 1], now), meta, now });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
};
