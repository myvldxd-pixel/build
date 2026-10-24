/* Texture helper for the builder (Roblox APIs do not allow cross-origin use from other sites):
   GET /api/tex?id=123            -> PNG preview of a Decal/Image id (cached by the Vercel CDN)
   GET /api/tex?info=123          -> { id, ok, type, name, state } (ok = a Decal or Image whose picture passed moderation)
   GET /api/tex?search=brick      -> { items: [{ id, name }] } from the Roblox Decal library (only ones with a ready picture) */
const getJSON = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('Roblox ' + r.status); return r.json(); };
const thumbs = async (ids, size) => {
  const j = await getJSON('https://thumbnails.roblox.com/v1/assets?assetIds=' + ids.join(',') + '&returnPolicy=PlaceHolder&size=' + (size || '420x420') + '&format=Png&isCircular=false');
  const out = {}; for (const d of (j && j.data) || []) out[String(d.targetId)] = d; return out;
};

module.exports = async (req, res) => {
  const q = req.query || {}, num = (s) => String(s || '').replace(/\D/g, '').slice(0, 20);
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (q.search != null) {
      const kw = String(q.search).slice(0, 60).trim(); if (!kw) return res.status(400).json({ error: 'search what?' });
      const j = await getJSON('https://apis.roblox.com/toolbox-service/v1/marketplace/13?keyword=' + encodeURIComponent(kw) + '&num=60');
      const ids = ((j && j.data) || []).map((d) => String(d.id)).slice(0, 60);
      const th = ids.length ? await thumbs(ids, '110x110') : {};
      const items = ids.filter((id) => th[id] && th[id].state === 'Completed').map((id) => ({ id }));
      res.setHeader('Cache-Control', 'public, s-maxage=3600');
      return res.json({ items });
    }
    if (q.info != null) {
      const id = num(q.info); if (!id) return res.status(400).json({ error: 'id required' });
      const [det, th] = await Promise.all([getJSON('https://economy.roblox.com/v2/assets/' + id + '/details').catch(() => null), thumbs([id], '110x110').catch(() => ({}))]);
      const type = det && det.AssetTypeId, state = th[id] ? th[id].state : 'unknown';
      res.setHeader('Cache-Control', 'public, s-maxage=3600');
      return res.json({ id, type, name: det && det.Name, state, ok: (type === 13 || type === 1) && state === 'Completed' });
    }
    const id = num(q.id); if (!id) return res.status(400).send('id required');
    const d = (await thumbs([id]))[id];
    if (!d || d.state !== 'Completed' || !d.imageUrl) { res.setHeader('Cache-Control', 'public, s-maxage=600'); return res.status(404).send('no image (' + (d ? d.state : 'unknown') + ')'); }
    const img = await fetch(d.imageUrl); if (!img.ok) return res.status(502).send('image fetch failed');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400');
    return res.status(200).send(Buffer.from(await img.arrayBuffer()));
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
};
