'use strict';
/* Liner: music discovery with a social layer. No servers: catalog and previews come from
   Deezer's public API (JSONP), everything you make lives in this browser, and people
   follow each other by opening compressed profile links. */

/* ================= utils ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/^the\s+/, '').replace(/\s*&\s*/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const uid = () => Math.random().toString(36).slice(2, 10);
const MD5 = /^[0-9a-f]{32}$/;
const mdOf = url => { const m = /\/images\/(?:cover|artist)\/([0-9a-f]{32})\//.exec(url || ''); return m ? m[1] : ''; };
const coverUrl = (md5, s = 250) => MD5.test(md5 || '') ? `https://cdn-images.dzcdn.net/images/cover/${md5}/${s}x${s}-000000-80-0-0.jpg` : '';
const artUrl = (md5, s = 250) => MD5.test(md5 || '') ? `https://cdn-images.dzcdn.net/images/artist/${md5}/${s}x${s}-000000-80-0-0.jpg` : '';
const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n | 0);
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 604800) return Math.floor(s / 86400) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function hash(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3400); }

const I = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-8-4.9-8-11A4.5 4.5 0 0 1 12 6.6a4.5 4.5 0 0 1 8 2.9c0 6.1-8 11-8 11z"/></svg>',
  post: '<svg viewBox="0 0 24 24"><path d="M4 20l1.2-4.2L16 5a2.1 2.1 0 0 1 3 3L8.2 18.8z"/></svg>',
  nope: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/></svg>',
  repost: '<svg viewBox="0 0 24 24"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
};

/* ================= state ================= */
const KEY = 'liner:v1';
function defaults() {
  return {
    me: { handle: 'digger' + (100 + Math.random() * 900 | 0), bio: '', hue: Math.random() * 360 | 0, since: Date.now(), key: uid() + uid() },
    crates: [], finds: [], posts: [], nope: {}, seen: {}, following: [], channels: [], dial: 0.5, trail: null,
  };
}
const S = (() => { try { const d = defaults(), v = JSON.parse(localStorage.getItem(KEY) || '{}'); return { ...d, ...v, me: { ...d.me, ...(v.me || {}) } }; } catch { return defaults(); } })();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch { pruneCache(true); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { toast('Browser storage is full. Remove a crate in Library to free space.'); } }
}

/* ================= Deezer API (JSONP + queue + cache) ================= */
const mem = new Map();
function cget(k) {
  if (mem.has(k)) return mem.get(k);
  try { const v = JSON.parse(localStorage.getItem('lc:' + k)); if (v && v.e > Date.now()) { mem.set(k, v.d); return v.d; } } catch { }
  return undefined;
}
function cset(k, d, ttlH) {
  mem.set(k, d);
  const s = JSON.stringify({ e: Date.now() + ttlH * 36e5, d });
  try { localStorage.setItem('lc:' + k, s); } catch { pruneCache(); try { localStorage.setItem('lc:' + k, s); } catch { } }
}
function pruneCache(all) {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('lc:'));
  keys.forEach((k, i) => {
    let exp = 0; try { exp = JSON.parse(localStorage.getItem(k)).e; } catch { }
    if (all || exp < Date.now() || i % 2) localStorage.removeItem(k);
  });
}
const Q = []; let active = 0, lastAt = 0, pumpT = 0;
function enqueue(fn) { return new Promise((res, rej) => { Q.push({ fn, res, rej }); pump(); }); }
function pump() {
  while (active < 4 && Q.length) {
    const wait = lastAt + 125 - Date.now();
    if (wait > 0) { if (!pumpT) pumpT = setTimeout(() => { pumpT = 0; pump(); }, wait); return; }
    lastAt = Date.now(); active++;
    const j = Q.shift();
    j.fn().then(j.res, j.rej).finally(() => { active--; pump(); });
  }
}
let jpN = 0;
function jsonp(path, params) {
  return new Promise((res, rej) => {
    const cb = '__dz' + (++jpN), s = document.createElement('script');
    const u = new URL('https://api.deezer.com/' + path);
    for (const k in params) u.searchParams.set(k, params[k]);
    u.searchParams.set('output', 'jsonp'); u.searchParams.set('callback', cb);
    const done = () => { clearTimeout(t); delete window[cb]; s.remove(); };
    const t = setTimeout(() => { done(); window[cb] = () => { }; rej(new Error('timeout')); }, 12000);
    window[cb] = d => { done(); d && d.error ? rej(Object.assign(new Error(d.error.message || 'Deezer error'), { code: d.error.code })) : res(d); };
    s.onerror = () => { done(); rej(new Error('network')); };
    s.src = u; document.head.appendChild(s);
  });
}
async function dz(path, params = {}) {
  for (let i = 0; ; i++) {
    try { return await enqueue(() => jsonp(path, params)); }
    catch (e) { if (i < 3 && (e.code === 4 || e.message === 'timeout')) { await new Promise(r => setTimeout(r, 1200 * (i + 1))); continue; } throw e; }
  }
}
async function dzc(path, params, ttl, map) {
  const k = path + '?' + new URLSearchParams(params);
  const hit = cget(k); if (hit !== undefined) return hit;
  const v = map(await dz(path, params)); cset(k, v, ttl); return v;
}
const mapTrack = t => ({ id: t.id, t: t.title_short || t.title || '', a: t.artist?.name || '', ai: t.artist?.id || 0, al: t.album?.title || '', c: t.album?.md5_image || t.md5_image || mdOf(t.album?.cover_medium), d: t.duration || 0 });
const mapArtist = a => ({ id: a.id, name: a.name, fans: a.nb_fan || 0, p: a.md5_image || mdOf(a.picture_medium) });
const api = {
  searchArtist: q => dzc('search/artist', { q, limit: 6 }, 168, d => (d.data || []).map(mapArtist)),
  searchTrack: q => dzc('search/track', { q, limit: 20 }, 24, d => (d.data || []).map(mapTrack)),
  related: id => dzc(`artist/${id}/related`, { limit: 30 }, 168, d => (d.data || []).map(mapArtist)),
  top: id => dzc(`artist/${id}/top`, { limit: 10 }, 72, d => (d.data || []).map(mapTrack)),
  artist: id => dzc(`artist/${id}`, {}, 168, mapArtist),
  chart: () => dzc('chart/0/tracks', { limit: 30 }, 6, d => (d.data || []).map(mapTrack)),
  genres: () => dzc('genre', {}, 168, d => (d.data || []).filter(g => g.id).map(g => ({ id: g.id, name: g.name, pic: g.picture_medium }))),
  genreArtists: id => dzc(`genre/${id}/artists`, {}, 48, d => (d.data || []).map(mapArtist)),
  track: id => dz(`track/${id}`),
};
async function resolveArtist(name) {
  const r = await api.searchArtist(name); if (!r.length) return null;
  const n = norm(name);
  return r.find(a => norm(a.name) === n) || r.find(a => { const m = norm(a.name); return m && (m.startsWith(n) || n.startsWith(m)); }) || null;
}

/* ================= registry for delegated events ================= */
const TR = new Map(); const reg = t => (TR.set(t.id, t), t.id);
const CTX = {}; // name -> () => [tracks], drives "next" in the player

/* ================= taste model ================= */
function tasteMap() {
  const m = new Map();
  const add = (name, w, id) => {
    const n = norm(name); if (!n) return;
    const e = m.get(n) || { name, n, w: 0, id: 0 }; e.w += w; if (id) e.id = id; m.set(n, e);
  };
  for (const c of S.crates) for (const [, a, x] of c.tracks) { add(a, 1); if (x) for (const o of x) add(o, .4); }
  for (const f of S.finds) add(f.a, 3, f.ai);
  for (const p of S.posts) add(p.tr.a, 3, p.tr.ai);
  return m;
}
function topArtists(n = 30) { return [...tasteMap().values()].sort((a, b) => b.w - a.w).slice(0, n); }
function seedList() {
  const m = tasteMap();
  const arr = [...m.values()].map(e => ({ ...e, w: Math.log2(1 + e.w) }));
  const byN = new Map(arr.map(e => [e.n, e]));
  for (const f of S.following) if (f.blend) for (const [id, name] of f.a.slice(0, 25)) {
    const n = norm(name); const e = byN.get(n);
    if (e) e.w += .8; else { const s = { name, n, id, w: 1.2, friend: f.h }; arr.push(s); byN.set(n, s); }
  }
  arr.sort((a, b) => b.w - a.w);
  return arr.slice(0, 90);
}
function knownNames() { return new Set(tasteMap().keys()); }

/* ================= discovery engine ================= */
const D = { pool: new Map(), used: new Set(), shownA: new Set(), knownIds: new Set(), cards: [], busy: null, exhausted: false };
function resetDiscovery(keepPool) {
  if (!keepPool) { D.pool.clear(); D.used.clear(); }
  D.shownA.clear(); D.cards = []; D.exhausted = false;
}
function dialFactor(fans) {
  const pop = Math.min(1, Math.max(0, (Math.log10(fans + 1) - 3) / 3.6)); // 1k fans -> 0, 4M -> 1
  const d = S.dial;
  return d < .5 ? 1 + (.5 - d) * 2.4 * (pop - .4) : 1 + (d - .5) * 2.8 * (.6 - pop);
}
function wsample(items, k) {
  return items.map(it => ({ it, key: Math.pow(Math.random(), 1 / Math.max(.01, it.w)) })).sort((a, b) => b.key - a.key).slice(0, k).map(x => x.it);
}
async function feedSeed(s) {
  D.used.add(s.n);
  let id = s.id;
  if (!id) { const a = await resolveArtist(s.name).catch(() => null); if (!a) return; id = s.id = a.id; }
  D.knownIds.add(id);
  const rel = await api.related(id).catch(() => []);
  rel.forEach((r, i) => {
    const c = D.pool.get(r.id) || { a: r, score: 0, via: new Map() };
    const add = s.w * (1 - i / 36);
    c.score += add; c.via.set(s.name, (c.via.get(s.name) || 0) + add);
    D.pool.set(r.id, c);
  });
  return rel;
}
function digMore(n = 6) {
  if (D.busy) return D.busy;
  D.busy = (async () => {
    const out = [];
    try {
      if (S.trail && !D.used.has(norm(S.trail.name))) {
        const ts = { name: S.trail.name, n: norm(S.trail.name), id: S.trail.id, w: 6 };
        const rel = await feedSeed(ts) || [];
        // walk one step further from the trail head so the trail has some reach
        await Promise.all(rel.slice(0, 5).map(r => feedSeed({ name: r.name, n: norm(r.name), id: r.id, w: 2 })));
      }
      const known = knownNames();
      for (let round = 0; round < 3 && out.length < n; round++) {
        const avail = seedList().filter(s => !D.used.has(s.n));
        const fresh = [...D.pool.values()].filter(c => !D.shownA.has(c.a.id)).length;
        if (avail.length && (fresh < n * 3 || round > 0)) await Promise.all(wsample(avail, round ? 6 : 5).map(feedSeed));
        const cand = [...D.pool.values()]
          .filter(c => !D.shownA.has(c.a.id) && !S.nope[c.a.id] && !D.knownIds.has(c.a.id) && !known.has(norm(c.a.name)))
          .map(c => ({ c, s: c.score * Math.max(.05, dialFactor(c.a.fans)) * (.8 + Math.random() * .4) }))
          .sort((x, y) => y.s - x.s).slice(0, n - out.length);
        if (!cand.length && !avail.length) { D.exhausted = true; break; }
        const got = await Promise.all(cand.map(async ({ c, s }) => {
          D.shownA.add(c.a.id);
          const tops = (await api.top(c.a.id).catch(() => [])).filter(t => t.ai === c.a.id);
          const pick = tops.slice(0, 6).filter(t => !S.seen[t.id]);
          const t = pick.length ? pick[Math.random() * Math.min(3, pick.length) | 0] : tops[0];
          if (!t) return null;
          S.seen[t.id] = Date.now();
          const via = [...c.via.entries()].sort((a, b) => b[1] - a[1]).map(v => v[0]);
          return { tr: t, artist: c.a, via, s };
        }));
        out.push(...got.filter(Boolean));
      }
      const seenIds = Object.keys(S.seen);
      if (seenIds.length > 4000) seenIds.sort((a, b) => S.seen[a] - S.seen[b]).slice(0, 1000).forEach(k => delete S.seen[k]);
      save();
    } finally { D.busy = null; }
    D.cards.push(...out);
    return out;
  })();
  return D.busy;
}

/* ================= player ================= */
const P = { audio: new Audio(), cur: null, ctx: null, loading: 0 };
P.audio.preload = 'auto';
async function play(id, ctx) {
  const tr = TR.get(id); if (!tr) return;
  if (P.cur && P.cur.id === id) { P.audio.paused ? P.audio.play().catch(() => { }) : P.audio.pause(); return; }
  P.cur = tr; if (ctx) P.ctx = ctx;
  const my = ++P.loading;
  P.audio.pause(); syncPlayer();
  try {
    const d = await api.track(id);
    if (my !== P.loading) return;
    if (!d.preview) { toast(`Deezer has no preview for “${tr.t}”. Skipping.`); return next(); }
    P.audio.src = d.preview;
    await P.audio.play();
  } catch (e) {
    if (my === P.loading && e.name !== 'AbortError') toast(e.name === 'NotAllowedError' ? 'Press play again to start audio.' : 'Could not load the preview. Check your connection.');
  }
  syncPlayer();
}
async function next() {
  if (!P.cur) return;
  let list = (CTX[P.ctx] || (() => []))();
  let i = list.findIndex(t => t.id === P.cur.id);
  if (P.ctx === 'foryou' && i >= list.length - 2 && !D.exhausted) { await digMore(); list = CTX.foryou(); renderMoreCards(); }
  const nx = list[i + 1];
  if (nx) { reg(nx); play(nx.id); } else { P.audio.pause(); syncPlayer(); }
}
P.audio.addEventListener('ended', next);
P.audio.addEventListener('play', syncPlayer);
P.audio.addEventListener('pause', syncPlayer);
P.audio.addEventListener('timeupdate', () => { $('#pprog').style.width = (P.audio.currentTime / (P.audio.duration || 30) * 100) + '%'; });
function isPlaying(id) { return P.cur && P.cur.id === id && !P.audio.paused; }
function syncPlayer() {
  const el = $('#player'), tr = P.cur;
  if (!tr) { el.hidden = true; return; }
  el.hidden = false;
  $('#pcover').src = coverUrl(tr.c, 120);
  $('#ptitle').textContent = tr.t;
  const pa = $('#partist'); pa.textContent = tr.a; pa.href = '#/artist/' + tr.ai;
  const on = !P.audio.paused;
  $('#ptoggle').innerHTML = on ? I.pause : I.play; $('#ptoggle').setAttribute('aria-label', on ? 'Pause' : 'Play');
  const sv = $('#psave'); sv.innerHTML = I.heart; sv.classList.toggle('on', isFound(tr.id)); sv.setAttribute('aria-label', isFound(tr.id) ? 'Remove from finds' : 'Save to finds');
  $$('[data-pl]').forEach(b => {
    const p = isPlaying(+b.dataset.pl);
    b.closest('.sleeve,.trk')?.classList.toggle('playing', p);
    if (b.classList.contains('playbtn')) b.innerHTML = (p ? I.pause : I.play) + (p ? 'Pause' : 'Play preview');
    else if (b.classList.contains('art')) { const s = b.querySelector('span'); if (s) s.innerHTML = p ? I.pause : I.play; }
  });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: tr.t, artist: tr.a, album: tr.al, artwork: [{ src: coverUrl(tr.c, 500), sizes: '500x500', type: 'image/jpeg' }] });
  }
}
$('#ptoggle').onclick = () => { if (P.cur) P.audio.paused ? P.audio.play().catch(() => { }) : P.audio.pause(); };
$('#pnext').onclick = next;
$('#psave').onclick = () => { if (P.cur) toggleFind(P.cur.id); };
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('play', () => P.audio.play());
  navigator.mediaSession.setActionHandler('pause', () => P.audio.pause());
}
document.addEventListener('keydown', e => {
  if (e.key === ' ' && P.cur && !e.target.closest('input,textarea,button,a,select,[contenteditable]')) { e.preventDefault(); $('#ptoggle').click(); }
});

/* ================= finds & posts ================= */
const isFound = id => S.finds.some(f => f.id === id);
function toggleFind(id, via) {
  const tr = TR.get(id); if (!tr) return;
  const i = S.finds.findIndex(f => f.id === id);
  if (i >= 0) { S.finds.splice(i, 1); toast('Removed from your finds.'); }
  else { S.finds.unshift({ ...tr, ts: Date.now(), via: via || '' }); toast(`Saved “${tr.t}” to your finds.`); }
  save(); syncHearts(); syncPlayer();
}
function syncHearts() { $$('[data-act=save]').forEach(b => { const on = isFound(+b.dataset.id); b.classList.toggle('on', on); b.setAttribute('aria-label', on ? 'Remove from finds' : 'Save to finds'); }); }
function addPost(tr, note, rp) {
  const p = { id: uid(), ts: Date.now(), note: note.slice(0, 280), tr: { id: tr.id, t: tr.t, a: tr.a, ai: tr.ai, al: tr.al, c: tr.c, d: tr.d || 0 } };
  if (rp) p.rp = rp;
  S.posts.unshift(p); save();
  return p;
}

/* ================= profile links ================= */
const b64u = {
  enc: u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec: s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); const b = atob(s + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); },
};
async function streamBytes(bytes, T) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(T)).arrayBuffer()); }
async function packProfile() {
  const me = S.me;
  const data = {
    v: 1, k: me.key, h: me.handle, b: me.bio, c: me.hue, s: me.since,
    a: topArtists(30).map(e => [e.id || 0, e.name]),
    p: S.posts.slice(0, 25).map(p => [p.id, p.ts, p.note, p.tr.id, p.tr.t, p.tr.a, p.tr.ai, p.tr.c, p.tr.al, p.rp ? p.rp.h : '']),
  };
  const z = await streamBytes(new TextEncoder().encode(JSON.stringify(data)), new CompressionStream('deflate-raw'));
  return location.origin + location.pathname + '#/u/' + b64u.enc(z);
}
async function unpackProfile(str) {
  const raw = JSON.parse(new TextDecoder().decode(await streamBytes(b64u.dec(str), new DecompressionStream('deflate-raw'))));
  const S_ = (v, n) => String(v ?? '').slice(0, n), N_ = v => Number.isFinite(+v) ? +v : 0;
  if (raw.v !== 1 || !raw.k) throw new Error('bad');
  return {
    k: S_(raw.k, 40), h: S_(raw.h, 24).replace(/[^\w.]/g, '') || 'someone', b: S_(raw.b, 200), c: N_(raw.c) % 360, s: N_(raw.s),
    a: (Array.isArray(raw.a) ? raw.a : []).slice(0, 30).map(x => [N_(x[0]), S_(x[1], 80)]).filter(x => x[1]),
    p: (Array.isArray(raw.p) ? raw.p : []).slice(0, 25).map(x => ({
      id: S_(x[0], 20), ts: Math.min(N_(x[1]), Date.now()), note: S_(x[2], 280),
      tr: { id: N_(x[3]), t: S_(x[4], 200), a: S_(x[5], 120), ai: N_(x[6]), c: MD5.test(x[7]) ? x[7] : '', al: S_(x[8], 200) },
      rp: x[9] ? { h: S_(x[9], 24) } : null,
    })).filter(p => p.tr.id),
    updated: Date.now(),
  };
}
async function copyProfileLink() {
  try {
    const url = await packProfile();
    if (navigator.share && matchMedia('(pointer:coarse)').matches) { await navigator.share({ title: `@${S.me.handle} on Liner`, url }).catch(() => { }); return; }
    await navigator.clipboard.writeText(url);
    toast('Profile link copied. Send it to a friend so they can follow you.');
  } catch { openModal('Your profile link', `<p class="small muted">Copy this link and send it to someone.</p><textarea readonly rows="5" onclick="this.select()">${esc(await packProfile())}</textarea>`); }
}
function matchWith(fa) {
  const mine = new Set(topArtists(60).map(e => e.n));
  const theirs = fa.map(x => norm(x[1])).filter(Boolean);
  if (!mine.size || !theirs.length) return { pct: 0, shared: [] };
  const shared = fa.filter(x => mine.has(norm(x[1]))).map(x => x[1]);
  const pct = Math.round(Math.min(1, shared.length / Math.sqrt(Math.min(30, mine.size) * theirs.length) * 1.6) * 100);
  return { pct, shared };
}
const followed = k => S.following.find(f => f.k === k);
let incoming = null; // profile currently being previewed from a link

/* ================= channels (genre desks built from Deezer charts) ================= */
async function channelPosts(gid) {
  const g = (await api.genres().catch(() => [])).find(x => x.id === gid); if (!g) return [];
  const day = new Date().toISOString().slice(0, 10);
  const k = `chp:${gid}:${day}`; const hit = cget(k); if (hit) return hit;
  const arts = await api.genreArtists(gid).catch(() => []);
  const r = rng(hash(k)); const pick = arts.slice().sort(() => r() - .5).slice(0, 4);
  const start = new Date(day + 'T00:00:00').getTime();
  const posts = (await Promise.all(pick.map(async (a, i) => {
    const tops = await api.top(a.id).catch(() => []); const t = tops[Math.floor(r() * Math.min(5, tops.length))];
    return t && { id: 'c' + gid + t.id, ts: start + 1 + i, note: `${a.name}: ${fmtN(a.fans)} fans on Deezer.`, tr: t, ch: { id: gid, name: g.name } };
  }))).filter(Boolean);
  cset(k, posts, 24);
  return posts;
}

/* ================= import parsing ================= */
const cleanArtist = s => String(s || '').replace(/\s+(feat\.?|ft\.?|featuring|with)\s+.*$/i, '').replace(/\s+/g, ' ').trim();
const cleanTitle = s => String(s || '').replace(/\.(mp3|flac|m4a|ogg|wav|opus|aac)$/i, '').replace(/^\s*\d{1,3}[\s.\-_)]+/, '').trim();
function splitArtists(s) {
  s = String(s || ''); const parts = (s.includes(';') ? s.split(';') : s.split(/,\s*/)).map(cleanArtist).filter(Boolean);
  return parts.length ? parts : [];
}
function trackRow(title, artistStr) { const as = splitArtists(artistStr); if (!as.length) return null; return as.length > 1 ? [cleanTitle(title), as[0], as.slice(1, 4)] : [cleanTitle(title), as[0]]; }
function parseCSV(txt) {
  const first = txt.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  if (rows.length < 2) return null;
  const h = rows[0].map(x => x.trim().toLowerCase());
  const ai = h.findIndex(x => /^(artist ?name\(s\)|artist ?names?|artists?|artist\(s\)|creator|performer|band)$/.test(x));
  const ti = h.findIndex(x => /^(track ?name|track ?title|track|title|song|song ?name|name)$/.test(x));
  if (ai < 0) return null;
  return rows.slice(1).map(r => trackRow(ti >= 0 ? r[ti] : '', r[ai])).filter(Boolean);
}
function parseLine(l) {
  l = l.replace(/^\s*(\d{1,4}[.)]\s+|[-*•]\s+)/, '').trim(); if (!l || l.startsWith('#')) return null;
  let m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(l); if (m) return trackRow(m[2], m[1]);
  m = /^(.+?)\s+by\s+(.+)$/i.exec(l); if (m) return trackRow(m[1], m[2]);
  m = /^(.+?)\t(.+)$/.exec(l); if (m) return trackRow(m[2], m[1]);
  return l.length < 80 ? trackRow('', l) : null; // a bare line is an artist name
}
function parseM3U(txt) {
  const out = []; let pending = null;
  for (const raw of txt.split(/\r?\n/)) {
    const l = raw.trim(); if (!l) continue;
    if (l.startsWith('#EXTINF')) { pending = parseLine(l.replace(/^#EXTINF:[^,]*,/, '')); continue; }
    if (l.startsWith('#')) continue;
    if (pending) { out.push(pending); pending = null; continue; }
    const base = decodeURIComponent(l.split(/[\\/]/).pop()).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_/g, ' ');
    const r = parseLine(base); if (r && r[0]) out.push(r);
  }
  return out;
}
function parseXSPF(txt) {
  const doc = new DOMParser().parseFromString(txt, 'application/xml');
  return [...doc.getElementsByTagName('track')].map(t => trackRow(t.getElementsByTagName('title')[0]?.textContent, t.getElementsByTagName('creator')[0]?.textContent)).filter(Boolean);
}
function parseJSON(txt) {
  const out = []; const seen = new WeakSet();
  const walk = o => {
    if (!o || typeof o !== 'object' || seen.has(o) || out.length > 20000) return; seen.add(o);
    if (!Array.isArray(o)) {
      const ak = Object.keys(o).find(k => /^(artistname|artist|artist_name|creator|artists)$/i.test(k));
      const tk = Object.keys(o).find(k => /^(trackname|track_name|title|track|name|song)$/i.test(k));
      let av = ak && o[ak]; if (Array.isArray(av)) av = av.map(x => typeof x === 'string' ? x : x?.name).filter(Boolean).join(';');
      else if (av && typeof av === 'object') av = av.name;
      if (typeof av === 'string' && av && (!tk || typeof o[tk] === 'string')) { const r = trackRow(tk ? o[tk] : '', av); if (r) { out.push(r); return; } }
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(JSON.parse(txt));
  return out;
}
function parseAny(txt, name = '') {
  txt = txt.replace(/^﻿/, '');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'xspf' || /^\s*(<\?xml|<playlist)/.test(txt)) return parseXSPF(txt);
  if (['json', 'jspf'].includes(ext) || /^\s*[[{]/.test(txt)) { try { return parseJSON(txt); } catch { } }
  if (['m3u', 'm3u8'].includes(ext) || /^#EXTM3U/.test(txt)) return parseM3U(txt);
  if (['csv', 'tsv'].includes(ext) || /^[^\n]*(artist|creator)[^\n]*[,;\t]/i.test(txt)) { const r = parseCSV(txt); if (r && r.length) return r; }
  return txt.split(/\r?\n/).map(parseLine).filter(Boolean);
}
async function importDeezer(url) {
  const m = /deezer\.com\/(?:[a-z]{2}\/)?(playlist|album)\/(\d+)/i.exec(url) || /^(playlist|album)?\s*(\d{4,})$/.exec(url.trim());
  if (!m) throw new Error('That is not a Deezer playlist or album link.');
  const kind = (m[1] || 'playlist').toLowerCase(), id = m[2];
  const info = await dz(`${kind}/${id}`);
  const rows = []; let index = 0;
  while (index < 3000) {
    const page = await dz(`${kind}/${id}/tracks`, { index, limit: 100 });
    for (const t of page.data || []) rows.push([t.title_short || t.title, t.artist?.name || '']);
    if (!page.next || !(page.data || []).length) break; index += 100;
  }
  return { name: info.title || 'Deezer ' + kind, rows: rows.filter(r => r[1]) };
}
function addCrate(name, rows, src) {
  if (!rows.length) { toast('No tracks or artists found in that. Check the format and try again.'); return false; }
  S.crates.unshift({ id: uid(), name: String(name).slice(0, 80) || 'Imported playlist', src, ts: Date.now(), tracks: rows.slice(0, 5000) });
  save(); resetDiscovery();
  const ar = new Set(rows.map(r => norm(r[1]))).size;
  toast(`Imported ${plural(rows.length, 'row')} with ${plural(ar, 'artist')}. Your feed now digs from them.`);
  return true;
}

/* ================= components ================= */
const avatar = (p, lg) => p.ch
  ? `<a class="av ch${lg ? ' lg' : ''}" href="#/genre/${p.ch.id}" aria-hidden="true" tabindex="-1">${esc(p.ch.name[0] || '#')}</a>`
  : `<a class="av${lg ? ' lg' : ''}" style="--h:${p.c | 0}" href="${p.self ? '#/me' : '#/p/' + esc(p.k)}" aria-hidden="true" tabindex="-1">${esc((p.h || '?')[0])}</a>`;
function trackHTML(t, ctx, opts = {}) {
  reg(t);
  const p = isPlaying(t.id);
  return `<div class="trk${p ? ' playing' : ''}${opts.n ? ' num' : ''}">
    ${opts.n ? `<span class="n">${opts.n}</span>` : ''}
    <button class="art" data-act="play" data-id="${t.id}" data-ctx="${ctx}" data-pl="${t.id}" aria-label="Play ${esc(t.t)}">${t.c ? `<img src="${coverUrl(t.c, 120)}" alt="" loading="lazy">` : ''}<span>${p ? I.pause : I.play}</span></button>
    <div class="t"><b>${esc(t.t)}</b><a href="#/artist/${t.ai}">${esc(t.a)}</a>${opts.sub ? `<small>${esc(opts.sub)}</small>` : ''}</div>
    <div class="ra">${opts.pick ? '' : `
      <button class="icon${isFound(t.id) ? ' on' : ''}" data-act="save" data-id="${t.id}" aria-label="Save to finds">${I.heart}</button>
      <button class="icon" data-act="compose" data-id="${t.id}" aria-label="Post about this track">${I.post}</button>`}</div>
  </div>`;
}
function sleeveHTML(c) {
  const t = c.tr; reg(t);
  const p = isPlaying(t.id), img = coverUrl(t.c, 400);
  const via = c.via.slice(0, 2), more = c.via.length - via.length;
  return `<article class="sleeve${p ? ' playing' : ''}" data-card="${t.id}">
    <div class="jacket"><div class="vinyl" style="--lbl:url('${coverUrl(t.c, 120)}')"></div>${img ? `<img src="${img}" alt="Cover of ${esc(t.al)}" loading="lazy">` : '<div class="noart"></div>'}</div>
    <div class="info">
      <h3>${esc(t.t)}</h3>
      <p class="by"><a href="#/artist/${c.artist.id}">${esc(c.artist.name)}</a> <span class="muted small">${fmtN(c.artist.fans)} fans</span></p>
      <p class="alb">${esc(t.al)}</p>
      <div class="tag">Near <b>${via.map(esc).join('</b> and <b>')}</b>${more > 0 ? ` and ${more} more of yours` : ''}</div>
    </div>
    <div class="acts">
      <button class="playbtn" data-act="play" data-id="${t.id}" data-ctx="foryou" data-pl="${t.id}">${p ? I.pause + 'Pause' : I.play + 'Play preview'}</button>
      <button class="icon${isFound(t.id) ? ' on' : ''}" data-act="save" data-id="${t.id}" data-via="${esc(via.join(', '))}" aria-label="Save to finds">${I.heart}</button>
      <button class="icon" data-act="compose" data-id="${t.id}" aria-label="Post about this track">${I.post}</button>
      <button class="icon nope" data-act="nope" data-artist="${c.artist.id}" data-name="${esc(c.artist.name)}" aria-label="Not for me: hide ${esc(c.artist.name)}">${I.nope}</button>
    </div>
  </article>`;
}
function postHTML(p, author, ctx, focus) {
  const t = p.tr;
  const name = author.ch ? esc(author.ch.name) : '@' + esc(author.h);
  const href = author.ch ? '#/genre/' + author.ch.id : author.self ? '#/me' : '#/p/' + esc(author.k);
  return `<article class="post${focus ? ' focus' : ''}" id="post-${esc(p.id)}">
    ${avatar(author)}
    <div>
      ${p.rp ? `<div class="rp">${I.repost.replace('<svg', '<svg style="width:14px;height:14px;vertical-align:-2px"')} reposted from @${esc(p.rp.h)}</div>` : ''}
      <div class="who"><a href="${href}">${name}</a>${author.ch ? '<span class="chip-ch">Channel</span>' : ''}<span>${author.ch ? 'today' : ago(p.ts)}</span></div>
      ${p.note ? `<p class="note">${esc(p.note)}</p>` : '<div style="height:8px"></div>'}
      ${trackHTML(t, ctx, { sub: t.al })}
      ${!author.self ? `<div class="row" style="margin-top:6px"><button class="btn sm" data-act="repost" data-id="${t.id}" data-from="${esc(author.ch ? author.ch.name : author.h)}">Repost</button></div>`
      : `<div class="row" style="margin-top:6px"><button class="btn sm" data-act="delpost" data-post="${esc(p.id)}">Delete</button></div>`}
    </div>
  </article>`;
}
const meAuthor = () => ({ self: true, h: S.me.handle, c: S.me.hue, k: S.me.key });
const loading = msg => `<div class="loading">${esc(msg)}</div>`;
function head(title, back) {
  return `<div class="head"><h1>${back ? `<a href="${back}" onclick="if(history.length>1){history.back();return false}" aria-label="Back">${I.back}</a>` : ''}${esc(title)}</h1></div>`;
}

/* ================= modal ================= */
const modal = $('#modal');
function openModal(title, body) {
  $('#modalBody').innerHTML = `<div class="mhead"><h2>${esc(title)}</h2><button class="icon" data-act="close" aria-label="Close">${I.x}</button></div><div class="mbody">${body}</div>`;
  if (!modal.open) modal.showModal();
}
modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });

function compose(trackId, presetNote = '', rp = null) {
  const tr = trackId ? TR.get(trackId) : null;
  const body = `
    <div id="cpick">${tr ? trackHTML(tr, 'compose', { pick: true, sub: tr.al }) : `
      <label class="f" for="cq">Find a track</label>
      <input type="search" id="cq" placeholder="Song or artist" autocomplete="off">
      <div class="results" id="cres"></div>`}</div>
    <label class="f" for="cnote">Say why it's good</label>
    <textarea id="cnote" maxlength="280" placeholder="The bass line at 0:40. That's it, that's the post.">${esc(presetNote)}</textarea>
    <div class="mfoot"><span class="count" id="ccount">${280 - presetNote.length}</span><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="cpost" ${tr ? '' : 'disabled'}>Post</button></div>`;
  openModal(rp ? 'Repost' : 'Share a find', body);
  let chosen = tr;
  const note = $('#cnote');
  note.oninput = () => { $('#ccount').textContent = 280 - note.value.length; };
  $('#cpost').onclick = () => {
    if (!chosen) return;
    addPost(chosen, note.value.trim(), rp);
    modal.close(); toast(rp ? 'Reposted to your profile.' : 'Posted to your profile. Share your profile link so friends see it.');
    if (curRoute === 'home' || curRoute === 'me') route();
  };
  const q = $('#cq');
  if (q) {
    q.focus();
    q.oninput = debounce(async () => {
      const v = q.value.trim(); const box = $('#cres'); if (!v) { box.innerHTML = ''; return; }
      box.innerHTML = loading('Searching');
      const res = await api.searchTrack(v).catch(() => null);
      if (q.value.trim() !== v) return;
      box.innerHTML = !res ? '<p class="muted">Search failed. Check your connection.</p>' : !res.length ? '<p class="muted">No tracks match that.</p>'
        : res.map(t => `<div data-choose="${reg(t)}">${trackHTML(t, 'compose', { pick: true, sub: t.al })}</div>`).join('');
    }, 300);
    $('#cres').addEventListener('click', e => {
      const row = e.target.closest('[data-choose]'); if (!row || e.target.closest('.art,a')) return;
      chosen = TR.get(+row.dataset.choose);
      $('#cpick').innerHTML = trackHTML(chosen, 'compose', { pick: true, sub: chosen.al }) + '<button class="btn sm" id="cchange" style="margin-top:4px">Pick another</button>';
      $('#cchange').onclick = () => compose(null, note.value);
      $('#cpost').disabled = false; note.focus();
    });
  }
}
function editProfile() {
  openModal('Edit profile', `
    <label class="f" for="eh">Handle</label><input type="text" id="eh" maxlength="20" value="${esc(S.me.handle)}">
    <p class="small muted" style="margin:4px 0 0">Letters, numbers, dots and underscores.</p>
    <label class="f" for="eb">Bio</label><textarea id="eb" maxlength="160" rows="3">${esc(S.me.bio)}</textarea>
    <label class="f" for="ec">Color</label><div class="row" style="flex-wrap:nowrap"><span class="av" id="eav" style="--h:${S.me.hue}">${esc(S.me.handle[0])}</span><input type="range" class="hue" id="ec" min="0" max="359" value="${S.me.hue}"></div>
    <div class="mfoot"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="esave">Save profile</button></div>`);
  $('#ec').oninput = e => { $('#eav').style.setProperty('--h', e.target.value); };
  $('#esave').onclick = () => {
    const h = $('#eh').value.trim().replace(/[^\w.]/g, '').slice(0, 20);
    if (h.length < 2) { toast('Handles need at least 2 characters.'); return; }
    S.me.handle = h; S.me.bio = $('#eb').value.trim().slice(0, 160); S.me.hue = +$('#ec').value; save();
    modal.close(); toast('Profile saved.'); renderShell(); route();
  };
}

/* ================= router & views ================= */
const view = $('#view');
let curRoute = '', renderId = 0;
function route() {
  const h = location.hash.slice(2) || 'home';
  const [r, ...rest] = h.split('/'); const arg = rest.join('/');
  curRoute = r; const my = ++renderId;
  $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === r || (r === 'home' && !a.dataset.nav)));
  const V = { home: vHome, explore: vExplore, library: vLibrary, people: vPeople, me: vMe, artist: vArtist, genre: vGenre, u: vIncoming, p: vPerson, search: vExplore }[r] || vHome;
  window.scrollTo(0, 0);
  Promise.resolve(V(arg, my)).catch(err => { console.error(err); if (my === renderId) view.innerHTML += `<div class="empty"><h2>That didn't load</h2><p>${esc(err.message)}. Check your connection and reload.</p></div>`; });
  renderRail();
}
const stale = my => my !== renderId;

/* ---------- home ---------- */
let homeTab = 'foryou', io;
async function vHome(_, my) {
  const t = homeTab;
  view.innerHTML = `<div class="head"><h1>Home</h1><div class="tabs" role="tablist">
      <button role="tab" class="${t === 'foryou' ? 'on' : ''}" data-act="htab" data-tab="foryou" aria-selected="${t === 'foryou'}">For you</button>
      <button role="tab" class="${t === 'following' ? 'on' : ''}" data-act="htab" data-tab="following" aria-selected="${t === 'following'}">Following</button></div></div>
    <div id="hbody"></div>`;
  return t === 'foryou' ? forYou(my) : followingFeed(my);
}
async function forYou(my) {
  const body = $('#hbody');
  if (!seedList().length && !S.trail) { body.innerHTML = onboardHTML(); wireOnboard(); return; }
  body.innerHTML = `
    ${S.trail ? `<div class="trailbar">On a trail from <b>${esc(S.trail.name)}</b><button data-act="endtrail">End trail</button></div>` : ''}
    <div class="dial"><label for="dial">Familiar</label><input type="range" id="dial" min="0" max="1" step=".05" value="${S.dial}" aria-label="From familiar to deep cuts"><span>Deep cuts</span></div>
    <div id="cards"></div><div id="more"></div>`;
  $('#dial').onchange = e => { S.dial = +e.target.value; save(); resetDiscovery(true); forYou(renderId); };
  CTX.foryou = () => D.cards.map(c => c.tr);
  const cards = $('#cards');
  if (D.cards.length) cards.innerHTML = D.cards.map(sleeveHTML).join('');
  else { $('#more').innerHTML = loading('Digging through artists near yours'); await digMore(); if (stale(my)) return; cards.innerHTML = D.cards.map(sleeveHTML).join(''); }
  setMore();
  io?.disconnect();
  io = new IntersectionObserver(async es => {
    if (!es[0].isIntersecting || D.busy || D.exhausted || stale(my)) return;
    $('#more').innerHTML = loading('Digging further');
    await digMore(); if (stale(my)) return; renderMoreCards();
  }, { rootMargin: '600px' });
  io.observe($('#more'));
}
function setMore() {
  const m = $('#more'); if (!m) return;
  m.innerHTML = D.exhausted ? `<div class="empty"><h2>You've dug this crate out</h2><p>Import another playlist, follow a friend and blend their taste, or start a trail from any artist in Explore.</p><a class="btn" href="#/explore">Go to Explore</a></div>`
    : !D.cards.length ? `<div class="empty"><h2>Nothing turned up yet</h2><p>Deezer didn't recognise enough of your artists. Add a few by name below or import another playlist.</p><a class="btn" href="#/library">Open Library</a></div>` : '';
}
function renderMoreCards() {
  const cards = $('#cards'); if (!cards) return;
  const have = new Set($$('[data-card]', cards).map(e => +e.dataset.card));
  cards.insertAdjacentHTML('beforeend', D.cards.filter(c => !have.has(c.tr.id)).map(sleeveHTML).join(''));
  setMore();
  // keep the observer firing when the new cards don't fill the viewport
  const m = $('#more'); if (m && !D.exhausted && m.getBoundingClientRect().top < innerHeight + 600) { io?.unobserve(m); io?.observe(m); }
}
function onboardHTML() {
  return `<div class="onboard">
    <h2>Start from the music you already love</h2>
    <p>Liner looks at the artists in your playlists, walks to the artists that sit next to them, and plays you a preview from each. Nothing you import leaves this browser.</p>
    <div class="row" style="margin:18px 0 26px"><a class="btn primary" href="#/library">Import a playlist</a></div>
    <label class="f" for="obq">Or name a few artists</label>
    <div class="sugg"><input type="search" id="obq" placeholder="Start typing an artist" autocomplete="off"><ul id="obs" hidden></ul></div>
    <div class="chips" id="obchips" style="margin:12px 0"></div>
    <button class="btn blue" id="obgo" disabled>Start digging</button>
  </div>`;
}
function wireOnboard() {
  const picked = new Map();
  const q = $('#obq'), list = $('#obs');
  const draw = () => {
    $('#obchips').innerHTML = [...picked.values()].map(a => `<span class="chip">${esc(a.name)}<button data-rm="${a.id}" aria-label="Remove ${esc(a.name)}">×</button></span>`).join('');
    $('#obgo').disabled = picked.size < 1; $('#obgo').textContent = picked.size < 3 ? `Start digging${picked.size ? '' : ''}` : `Start digging from ${picked.size} artists`;
  };
  q.oninput = debounce(async () => {
    const v = q.value.trim(); if (!v) { list.hidden = true; return; }
    const r = await api.searchArtist(v).catch(() => []);
    if (q.value.trim() !== v) return;
    list.innerHTML = r.map(a => `<li><button data-add='${esc(JSON.stringify(a))}'>${a.p ? `<img src="${artUrl(a.p, 56)}" alt="">` : '<img alt="">'}<span>${esc(a.name)} <small class="muted">${fmtN(a.fans)} fans</small></span></button></li>`).join('');
    list.hidden = !r.length;
  }, 250);
  list.onclick = e => { const b = e.target.closest('[data-add]'); if (!b) return; const a = JSON.parse(b.dataset.add); picked.set(a.id, a); q.value = ''; list.hidden = true; q.focus(); draw(); };
  $('#obchips').onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { picked.delete(+b.dataset.rm); draw(); } };
  $('#obgo').onclick = () => {
    const rows = [...picked.values()].map(a => ['', a.name]);
    addCrate('Artists I picked', rows, 'picked'); vHome('', renderId); renderRail();
  };
}
async function followingFeed(my) {
  const body = $('#hbody');
  const items = S.posts.map(p => ({ p, au: meAuthor() }));
  for (const f of S.following) for (const p of f.p) items.push({ p, au: f });
  const chans = S.channels.length;
  if (!items.length && !chans) {
    body.innerHTML = `<div class="empty"><h2>No posts yet</h2><p>Follow a channel in Explore for daily picks, paste a friend's profile link in People, or post a find yourself.</p><div class="row" style="justify-content:center"><a class="btn" href="#/explore">Browse channels</a><a class="btn" href="#/people">Add a friend</a></div></div>`;
    return;
  }
  const draw = extra => {
    const all = items.concat(extra).sort((a, b) => b.p.ts - a.p.ts);
    CTX.following = () => all.map(x => x.p.tr);
    body.innerHTML = all.map(x => postHTML(x.p, x.au, 'following')).join('') || '';
  };
  draw([]);
  if (chans) {
    body.insertAdjacentHTML('afterbegin', loading('Loading channel picks'));
    const extra = (await Promise.all(S.channels.map(id => channelPosts(id).catch(() => [])))).flat().map(p => ({ p, au: { ch: p.ch } }));
    if (stale(my) || homeTab !== 'following') return;
    draw(extra);
  }
}

/* ---------- explore ---------- */
async function vExplore(arg, my) {
  view.innerHTML = `${head('Explore')}
    <div class="section"><label class="sr" for="xq">Search</label><input type="search" id="xq" placeholder="Search artists and tracks" value="${esc(decodeURIComponent(arg || ''))}" autocomplete="off"></div>
    <div id="xres"></div>
    <div id="xdefault"><div class="section" style="border:0;padding-bottom:6px"><h2>Channels</h2><p class="muted small">Daily picks from Deezer's genre charts. Follow one and its picks show up in your Following feed.</p></div><div class="genres" id="xgen">${loading('Loading channels')}</div>
    <div class="section" style="border-top:1px solid var(--line);border-bottom:0;padding-bottom:4px"><h2>Charting today</h2></div><div id="xchart">${loading('Loading chart')}</div></div>`;
  const q = $('#xq');
  const search = async v => {
    const res = $('#xres'), def = $('#xdefault');
    if (!v) { res.innerHTML = ''; def.hidden = false; return; }
    def.hidden = true; res.innerHTML = loading('Searching');
    const [ar, tr] = await Promise.all([api.searchArtist(v).catch(() => []), api.searchTrack(v).catch(() => [])]);
    if (q.value.trim() !== v || stale(my)) return;
    CTX.search = () => tr;
    res.innerHTML = (!ar.length && !tr.length) ? `<div class="empty"><h2>No matches</h2><p>Try a shorter name or check the spelling.</p></div>` :
      `${ar.length ? `<div class="section" style="border:0;padding-bottom:4px"><h2>Artists</h2></div><div class="agrid">${ar.map(artistCard).join('')}</div>` : ''}
       ${tr.length ? `<div class="section" style="border:0;padding-bottom:4px"><h2>Tracks</h2></div>${tr.map(t => trackHTML(t, 'search', { sub: t.al })).join('')}` : ''}`;
  };
  q.oninput = debounce(() => { const v = q.value.trim(); history.replaceState(null, '', '#/explore' + (v ? '/' + encodeURIComponent(v) : '')); search(v); }, 300);
  if (arg) search(decodeURIComponent(arg));
  const [gs, ch] = await Promise.all([api.genres().catch(() => []), api.chart().catch(() => [])]);
  if (stale(my)) return;
  $('#xgen').innerHTML = gs.map(g => `<a class="genre" href="#/genre/${g.id}"><img src="${esc(g.pic)}" alt="" loading="lazy"><span>${esc(g.name)}${S.channels.includes(g.id) ? ' (following)' : ''}</span></a>`).join('') || '<p class="muted">Channels did not load.</p>';
  CTX.chart = () => ch;
  $('#xchart').innerHTML = ch.map((t, i) => trackHTML(t, 'chart', { n: i + 1, sub: t.al })).join('') || '<p class="section muted">The chart did not load.</p>';
}
const artistCard = a => `<a class="acard" href="#/artist/${a.id}">${a.p ? `<img src="${artUrl(a.p)}" alt="" loading="lazy">` : '<div class="noimg"></div>'}${esc(a.name)}<small>${fmtN(a.fans)} fans</small></a>`;

async function vArtist(id, my) {
  id = +id; view.innerHTML = head('Artist', '#/explore') + loading('Loading artist');
  const [a, tops, rel] = await Promise.all([api.artist(id), api.top(id).catch(() => []), api.related(id).catch(() => [])]);
  if (stale(my)) return;
  const known = knownNames().has(norm(a.name));
  CTX.artist = () => tops;
  const q = encodeURIComponent(a.name);
  view.innerHTML = head(a.name, '#/explore') + `
    <div class="ghead">${a.p ? `<img src="${artUrl(a.p, 500)}" alt="">` : '<img alt="">'}<div><h2>${esc(a.name)}</h2><p>${fmtN(a.fans)} fans on Deezer${known ? '. Already in your taste.' : ''}</p>
      <div class="row"><button class="btn blue" data-act="trail" data-id="${a.id}" data-name="${esc(a.name)}">Start a trail here</button>
      ${known ? '' : `<button class="btn" data-act="addtaste" data-name="${esc(a.name)}">Add to my taste</button>`}</div>
      <div class="row small" style="margin-top:10px"><a class="muted" href="https://www.deezer.com/artist/${a.id}" target="_blank" rel="noopener">Deezer</a><a class="muted" href="https://open.spotify.com/search/${q}" target="_blank" rel="noopener">Spotify</a><a class="muted" href="https://music.youtube.com/search?q=${q}" target="_blank" rel="noopener">YouTube Music</a><a class="muted" href="https://bandcamp.com/search?q=${q}" target="_blank" rel="noopener">Bandcamp</a></div></div></div>
    <div class="section" style="border:0;padding-bottom:4px"><h2>Top tracks</h2></div>
    ${tops.map((t, i) => trackHTML(t, 'artist', { n: i + 1, sub: t.al })).join('') || '<p class="section muted">No tracks found.</p>'}
    ${rel.length ? `<div class="section" style="border-top:1px solid var(--line);border-bottom:0;padding-bottom:4px"><h2>Sounds near ${esc(a.name)}</h2></div><div class="agrid">${rel.slice(0, 18).map(artistCard).join('')}</div>` : ''}`;
}
async function vGenre(id, my) {
  id = +id; view.innerHTML = head('Channel', '#/explore') + loading('Loading channel');
  const [gs, arts] = await Promise.all([api.genres(), api.genreArtists(id).catch(() => [])]);
  if (stale(my)) return;
  const g = gs.find(x => x.id === id) || { name: 'Channel', pic: '' };
  const on = S.channels.includes(id);
  view.innerHTML = head(g.name, '#/explore') + `
    <div class="ghead"><img src="${esc(g.pic)}" alt=""><div><h2>${esc(g.name)}</h2><p>Four picks a day from the artists charting in ${esc(g.name)} on Deezer.</p>
      <button class="btn ${on ? '' : 'primary'}" data-act="chan" data-id="${id}">${on ? 'Following' : 'Follow channel'}</button></div></div>
    <div class="section" style="border:0;padding-bottom:4px"><h2>Charting artists</h2></div>
    <div class="agrid">${arts.map(artistCard).join('')}</div>`;
}

/* ---------- library ---------- */
let libTab = 'crates';
function vLibrary() {
  const t = libTab;
  view.innerHTML = `<div class="head"><h1>Library</h1><div class="tabs">
      <button class="${t === 'crates' ? 'on' : ''}" data-act="ltab" data-tab="crates">Crates</button>
      <button class="${t === 'finds' ? 'on' : ''}" data-act="ltab" data-tab="finds">Finds (${S.finds.length})</button></div></div><div id="lbody"></div>`;
  t === 'crates' ? libCrates() : libFinds();
}
function libCrates() {
  $('#lbody').innerHTML = `
    <div class="section">
      <h2>Import a playlist</h2>
      <p class="muted small">Your playlists are the reference point: Liner digs from the artists in them and never recommends ones you already have.</p>
      <div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose playlist files"><div><b>Drop playlist files here</b><br><span class="muted small">or click to choose. CSV, M3U, M3U8, XSPF, JSPF, JSON or TXT</span></div></div>
      <input type="file" id="file" multiple accept=".csv,.tsv,.m3u,.m3u8,.xspf,.jspf,.json,.txt" hidden>
      <label class="f" for="dzurl">Deezer playlist or album link</label>
      <div class="row" style="flex-wrap:nowrap"><input type="url" id="dzurl" placeholder="https://www.deezer.com/playlist/…"><button class="btn primary" id="dzgo">Import</button></div>
      <label class="f" for="paste">Or paste a list</label>
      <textarea id="paste" rows="4" placeholder="One per line: Artist - Song, Song by Artist, or just an artist name"></textarea>
      <div class="row" style="margin-top:8px"><input type="text" id="pname" placeholder="Name this crate" style="flex:1;min-width:160px"><button class="btn primary" id="pgo">Import list</button></div>
      <details style="margin-top:14px"><summary><b>Coming from Spotify, Apple Music or YouTube?</b></summary>
        <ol class="steps small" style="margin-top:8px">
          <li>Spotify: open <a href="https://exportify.app" target="_blank" rel="noopener">exportify.app</a>, sign in, export a playlist as CSV, then drop the file here. A full Spotify account data export (the JSON files) also works.</li>
          <li>Apple Music or YouTube Music: export with a converter such as <a href="https://www.tunemymusic.com" target="_blank" rel="noopener">TuneMyMusic</a> to a CSV or TXT file.</li>
          <li>Local files: save the playlist as M3U from your player (VLC, foobar2000, iTunes) and drop it here.</li>
        </ol></details>
    </div>
    <div id="crates">${S.crates.length ? S.crates.map(crateHTML).join('') : '<div class="empty"><h2>No crates yet</h2><p>Import a playlist above to give Liner something to dig from.</p></div>'}</div>
    <div class="section"><h2>Backup</h2><p class="muted small">Everything lives in this browser. Save a backup to move it to another device.</p>
      <div class="row"><button class="btn" data-act="backup">Download backup</button><button class="btn" data-act="restore">Restore backup</button><input type="file" id="restorefile" accept=".json" hidden></div></div>`;
  const drop = $('#drop'), file = $('#file');
  const readFiles = async fs => {
    for (const f of fs) {
      if (f.size > 30e6) { toast(`${f.name} is too large.`); continue; }
      const rows = parseAny(await f.text(), f.name);
      addCrate(f.name.replace(/\.[^.]+$/, ''), rows, 'file');
    }
    libCrates(); renderRail();
  };
  drop.onclick = () => file.click(); drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } };
  file.onchange = () => readFiles([...file.files]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); readFiles([...e.dataTransfer.files]); };
  $('#dzgo').onclick = async () => {
    const v = $('#dzurl').value.trim(); if (!v) return;
    if (/spotify\.com|spotify:/.test(v)) { toast('Spotify links need a login. Export the playlist with exportify.app and drop the CSV here.'); return; }
    const b = $('#dzgo'); b.disabled = true; b.textContent = 'Importing';
    try { const { name, rows } = await importDeezer(v); addCrate(name, rows, 'deezer'); libCrates(); renderRail(); }
    catch (e) { toast(e.message.startsWith('That') ? e.message : 'Could not read that playlist. Make sure it is public.'); b.disabled = false; b.textContent = 'Import'; }
  };
  $('#pgo').onclick = () => {
    const rows = parseAny($('#paste').value);
    if (addCrate($('#pname').value.trim() || 'Pasted list', rows, 'paste')) { libCrates(); renderRail(); }
  };
  $('#restorefile').onchange = async e => {
    try {
      const d = JSON.parse(await e.target.files[0].text()); if (!d.me || !d.crates) throw 0;
      Object.assign(S, defaults(), d); save(); resetDiscovery(); toast('Backup restored.'); renderShell(); route();
    } catch { toast('That file is not a Liner backup.'); }
  };
}
function crateHTML(c) {
  const counts = new Map(); for (const [, a] of c.tracks) counts.set(a, (counts.get(a) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
  return `<div class="crate"><div class="stack">${c.tracks.length > 999 ? fmtN(c.tracks.length) : c.tracks.length}</div>
    <div style="min-width:0"><b>${esc(c.name)}</b><small>${plural(counts.size, 'artist')}: ${esc(top.join(', '))}</small></div>
    <button class="btn sm" data-act="delcrate" data-id="${esc(c.id)}">Remove</button></div>`;
}
function libFinds() {
  const b = $('#lbody');
  if (!S.finds.length) { b.innerHTML = `<div class="empty"><h2>Nothing saved yet</h2><p>Tap the heart on anything in your feed. Finds feed back into your taste, and you can export them to rebuild a playlist anywhere.</p><a class="btn" href="#/home">Back to your feed</a></div>`; return; }
  CTX.finds = () => S.finds;
  b.innerHTML = `<div class="section row"><span class="muted small" style="margin-right:auto">${plural(S.finds.length, 'track')} saved</span><button class="btn sm" data-act="exportfinds" data-fmt="csv">Export CSV</button><button class="btn sm" data-act="exportfinds" data-fmt="txt">Export text</button></div>
    ${S.finds.map(f => trackHTML(f, 'finds', { sub: f.via ? `Near ${f.via}` : f.al })).join('')}`;
}

/* ---------- people ---------- */
function vPeople() {
  view.innerHTML = `${head('People')}
    <div class="section">
      <h2>Follow someone</h2>
      <p class="muted small">Liner has no accounts or servers. People share their profile as a link; open it or paste it here to follow them. When they post new finds, ask for a fresh link.</p>
      <div class="row" style="flex-wrap:nowrap"><input type="url" id="plink" placeholder="Paste a Liner profile link"><button class="btn primary" id="pgo">Open</button></div>
      <div class="row" style="margin-top:12px"><button class="btn" data-act="sharelink">Copy my profile link</button></div>
    </div>
    <div id="plist">${S.following.length ? S.following.map(personRow).join('') : '<div class="empty"><h2>You aren\'t following anyone yet</h2><p>Copy your profile link and send it to a friend who has good taste. Ask them for theirs.</p></div>'}</div>`;
  $('#pgo').onclick = () => {
    const v = $('#plink').value.trim(); const m = /#\/u\/([\w-]+)/.exec(v);
    if (!m) { toast('That is not a Liner profile link.'); return; }
    location.hash = '#/u/' + m[1];
  };
}
function personRow(f) {
  const m = matchWith(f.a);
  return `<div class="post" style="align-items:center">${avatar(f)}<div class="row" style="justify-content:space-between">
    <div style="min-width:0"><a href="#/p/${esc(f.k)}" style="text-decoration:none"><b>@${esc(f.h)}</b></a><div class="small muted">${m.pct}% taste match, ${plural(f.p.length, 'post')}, updated ${ago(f.updated)}</div></div>
    <div class="row"><button class="btn sm${f.blend ? ' blue' : ''}" data-act="blend" data-k="${esc(f.k)}" aria-pressed="${!!f.blend}">${f.blend ? 'Blended into feed' : 'Blend into feed'}</button><button class="btn sm" data-act="unfollow" data-k="${esc(f.k)}">Unfollow</button></div></div></div>`;
}

/* ---------- profiles ---------- */
function profileHTML(pr, self, focusId) {
  const m = self ? null : matchWith(pr.a);
  const sharedSet = new Set((m?.shared || []).map(norm));
  const ctx = self ? 'mine' : 'theirs';
  const au = self ? meAuthor() : pr;
  CTX[ctx] = () => pr.p.map(p => p.tr);
  const fol = !self && followed(pr.k);
  return `<div class="band" style="--h:${pr.c | 0}"></div>
    <div class="phead"><div class="top">${avatar(au, true)}<div class="row">
      ${self ? `<button class="btn" data-act="editprofile">Edit profile</button><button class="btn primary" data-act="sharelink">Copy profile link</button>`
      : `<button class="btn ${fol ? '' : 'primary'}" data-act="${fol ? 'unfollow' : 'follow'}" data-k="${esc(pr.k)}">${fol ? 'Following' : 'Follow'}</button>`}</div></div>
      <h2>@${esc(pr.h)}</h2>
      ${pr.b ? `<p class="bio">${esc(pr.b)}</p>` : self ? '<p class="bio muted">Add a bio so friends know what you dig.</p>' : ''}
      <div class="stats"><span><b>${pr.a.length >= 30 ? '30+' : pr.a.length}</b> artists in taste</span><span><b>${pr.p.length}</b> posts</span>${self ? `<span><b>${S.finds.length}</b> finds</span><span><b>${S.crates.length}</b> crates</span>` : ''}${pr.s ? `<span>Digging since ${new Date(pr.s).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>` : ''}</div>
      ${m ? `<div class="match"><strong>${m.pct}%</strong>taste match${m.shared.length ? `. You both have ${esc(m.shared.slice(0, 4).join(', '))}${m.shared.length > 4 ? ` and ${m.shared.length - 4} more` : ''}.` : '. No artists in common yet, so their finds are all new to you.'}</div>` : ''}
    </div>
    ${pr.a.length ? `<div class="section"><h2>${self ? 'Your taste' : 'Their taste'}</h2><div class="chips">${pr.a.map(([id, n]) => `<a class="chip${sharedSet.has(norm(n)) ? ' shared' : ''}" ${id ? `href="#/artist/${id}"` : `href="#/explore/${encodeURIComponent(n)}"`}>${esc(n)}</a>`).join('')}</div></div>` : ''}
    <div class="section" style="border:0;padding-bottom:0"><h2>Posts</h2></div>
    ${pr.p.length ? pr.p.map(p => postHTML(p, au, ctx, p.id === focusId)).join('') : `<p class="section muted" style="border:0">${self ? 'Share a find and it shows up here.' : 'No posts in this link yet.'}</p>`}`;
}
function vMe() {
  const pr = { k: S.me.key, h: S.me.handle, b: S.me.bio, c: S.me.hue, s: S.me.since, a: topArtists(30).map(e => [e.id, e.name]), p: S.posts };
  view.innerHTML = head('Profile') + profileHTML(pr, true);
}
function vPerson(k) {
  const f = followed(k);
  if (!f && incoming && incoming.k === k) { view.innerHTML = head('@' + incoming.h, '#/people') + profileHTML(incoming, false); return; }
  if (!f) { view.innerHTML = head('Profile', '#/people') + `<div class="empty"><h2>Not following this person</h2><p>Open their profile link to see their profile.</p></div>`; return; }
  view.innerHTML = head('@' + f.h, '#/people') + profileHTML(f, false);
}
async function vIncoming(data) {
  view.innerHTML = head('Profile', '#/people') + loading('Opening profile link');
  try { incoming = await unpackProfile(data); }
  catch { view.innerHTML = head('Profile', '#/people') + `<div class="empty"><h2>This link is broken</h2><p>The profile link was cut off or changed. Ask for a fresh one.</p></div>`; return; }
  if (incoming.k === S.me.key) { view.innerHTML = head('Your profile link', '#/me') + `<div class="section"><p>This is your own profile link. Anyone who opens it can follow you and see your posts as they were when you copied it.</p></div>` + profileHTML({ ...incoming }, true); return; }
  const f = followed(incoming.k);
  if (f) { Object.assign(f, incoming); save(); toast(`Updated @${incoming.h} with their latest posts.`); renderRail(); }
  view.innerHTML = head('@' + incoming.h, '#/people') + profileHTML(f || incoming, false);
}

/* ---------- rail ---------- */
function renderRail() {
  const rail = $('#rail');
  const top = topArtists(14);
  const sugg = [...new Set([132, 116, 152, 113, 129, 106, 85])].filter(id => !S.channels.includes(id)).slice(0, 4);
  rail.innerHTML = `
    <div class="box"><h2>Your taste</h2>${top.length ? `<div class="chips">${top.map(e => `<a class="chip" href="${e.id ? '#/artist/' + e.id : '#/explore/' + encodeURIComponent(e.name)}">${esc(e.name)}</a>`).join('')}</div>
      <p class="small muted" style="margin:10px 0 0">From ${plural(S.crates.length, 'crate')} and ${plural(S.finds.length, 'find')}.</p>` : '<p class="small muted" style="margin:0">Import a playlist and your top artists show up here.</p><a class="btn sm" href="#/library" style="margin-top:10px">Import a playlist</a>'}</div>
    <div class="box"><h2>People</h2>${S.following.length ? S.following.slice(0, 5).map(f => `<a class="person" href="#/p/${esc(f.k)}">${avatar(f).replace(/<a /, '<span ').replace(/<\/a>$/, '</span>')}<div><b>@${esc(f.h)}</b><small>${matchWith(f.a).pct}% match</small></div></a>`).join('')
      : '<p class="small muted" style="margin:0 0 10px">Friends follow each other by swapping profile links.</p>'}<button class="btn sm" data-act="sharelink" style="margin-top:6px">Copy my profile link</button></div>
    <div class="box" id="railch"><h2>Channels</h2><p class="small muted" style="margin:0">Loading</p></div>
    <p class="foot">Catalog, artwork and 30-second previews from the <a href="https://developers.deezer.com" target="_blank" rel="noopener">Deezer API</a>. Your data stays in this browser.</p>`;
  api.genres().then(gs => {
    const box = $('#railch'); if (!box) return;
    const show = gs.filter(g => S.channels.includes(g.id) || sugg.includes(g.id)).slice(0, 6);
    box.innerHTML = '<h2>Channels</h2>' + show.map(g => { const on = S.channels.includes(g.id); return `<div class="person"><a href="#/genre/${g.id}" style="text-decoration:none"><b>${esc(g.name)}</b></a><button class="btn sm ${on ? '' : 'primary'}" data-act="chan" data-id="${g.id}">${on ? 'Following' : 'Follow'}</button></div>`; }).join('');
  }).catch(() => { const b = $('#railch'); if (b) b.remove(); });
}
function renderShell() {
  $('#mecard').innerHTML = `<span class="av" style="--h:${S.me.hue}">${esc(S.me.handle[0])}</span><div><b>@${esc(S.me.handle)}</b><small>${plural(S.posts.length, 'post')}</small></div>`;
}

/* ================= actions ================= */
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const ACT = {
  play: b => play(+b.dataset.id, b.dataset.ctx),
  save: b => toggleFind(+b.dataset.id, b.dataset.via),
  compose: b => compose(b.dataset.id ? +b.dataset.id : null),
  repost: b => compose(+b.dataset.id, '', { h: b.dataset.from }),
  close: () => modal.close(),
  htab: b => { homeTab = b.dataset.tab; route(); },
  ltab: b => { libTab = b.dataset.tab; route(); },
  nope: b => {
    S.nope[b.dataset.artist] = 1; save();
    const card = b.closest('.sleeve'); const id = +card.dataset.card;
    D.cards = D.cards.filter(c => c.tr.id !== id); card.remove();
    if (P.cur?.id === id) next();
    toast(`You won't see ${b.dataset.name} again.`);
    renderMoreCards();
  },
  endtrail: () => { S.trail = null; save(); resetDiscovery(); route(); },
  trail: b => { S.trail = { id: +b.dataset.id, name: b.dataset.name }; save(); resetDiscovery(); homeTab = 'foryou'; location.hash = '#/home'; },
  addtaste: b => {
    let c = S.crates.find(c => c.src === 'picked');
    if (!c) { c = { id: uid(), name: 'Artists I picked', src: 'picked', ts: Date.now(), tracks: [] }; S.crates.unshift(c); }
    c.tracks.push(['', b.dataset.name]); save(); resetDiscovery(); toast(`Added ${b.dataset.name} to your taste.`); b.remove(); renderRail();
  },
  chan: b => {
    const id = +b.dataset.id, i = S.channels.indexOf(id);
    i >= 0 ? S.channels.splice(i, 1) : S.channels.push(id); save();
    toast(i >= 0 ? 'Unfollowed channel.' : 'Following. Its daily picks show up in Home, under Following.');
    if (curRoute === 'genre') route(); else renderRail();
  },
  delcrate: b => {
    const c = S.crates.find(c => c.id === b.dataset.id); if (!c || !confirm(`Remove “${c.name}”? Its artists stop shaping your feed.`)) return;
    S.crates = S.crates.filter(x => x !== c); save(); resetDiscovery(); libCrates(); renderRail();
  },
  delpost: b => { if (!confirm('Delete this post?')) return; S.posts = S.posts.filter(p => p.id !== b.dataset.post); save(); renderShell(); route(); },
  editprofile: editProfile,
  sharelink: copyProfileLink,
  follow: b => {
    if (!incoming || incoming.k !== b.dataset.k) return;
    S.following.unshift({ ...incoming, blend: false }); save();
    toast(`Following @${incoming.h}. Their posts show up in Home, under Following.`); location.hash = '#/p/' + incoming.k;
  },
  unfollow: b => {
    const f = followed(b.dataset.k); if (!f || !confirm(`Unfollow @${f.h}?`)) return;
    incoming = incoming && incoming.k === f.k ? incoming : { ...f };
    S.following = S.following.filter(x => x !== f); save(); resetDiscovery(); route();
  },
  blend: b => {
    const f = followed(b.dataset.k); if (!f) return; f.blend = !f.blend; save(); resetDiscovery();
    toast(f.blend ? `Your For you feed now also digs from @${f.h}'s artists.` : `Stopped blending @${f.h}.`); route();
  },
  exportfinds: b => {
    if (b.dataset.fmt === 'csv') download('liner-finds.csv', 'Track name,Artist name,Album\n' + S.finds.map(f => [f.t, f.a, f.al].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
    else download('liner-finds.txt', S.finds.map(f => `${f.a} - ${f.t}`).join('\n'), 'text/plain');
  },
  backup: () => download(`liner-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(S), 'application/json'),
  restore: () => $('#restorefile').click(),
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const fn = ACT[b.dataset.act]; if (!fn) return;
  e.preventDefault(); fn(b);
});

/* ================= boot ================= */
addEventListener('hashchange', route);
addEventListener('storage', e => { if (e.key === KEY) location.reload(); });
renderShell(); route();
