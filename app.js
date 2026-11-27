'use strict';
/* Sidetrack — an endless, full-screen feed of new music picked from the music you already love.
   Catalog and 30-second previews: Deezer public API (JSONP) + its CDN (CORS).
   Taste: artist graph from your imported playlists + a small on-device model that listens
   to each preview (timbre, brightness, energy, tempo) and learns from likes and skips.
   Data: candidates are judged from a 160 KB slice of their preview; only songs that become
   a slide are downloaded in full, and those same bytes are what plays. */

/* ================= utils ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/^the\s+/, '').replace(/\s*&\s*/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stripParen = s => String(s || '').replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+-\s+.*(remaster|version|edit|mix|live).*$/i, '').trim();
const uid = () => Math.random().toString(36).slice(2, 10);
const MD5 = /^[0-9a-f]{32}$/;
const mdOf = url => { const m = /\/images\/(?:cover|artist)\/([0-9a-f]{32})\//.exec(url || ''); return m ? m[1] : ''; };
const coverUrl = (md5, s) => MD5.test(md5 || '') ? `https://cdn-images.dzcdn.net/images/cover/${md5}/${s}x${s}-000000-80-0-0.jpg` : '';
const artUrl = (md5, s) => MD5.test(md5 || '') ? `https://cdn-images.dzcdn.net/images/artist/${md5}/${s}x${s}-000000-80-0-0.jpg` : '';
const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n | 0);
const plural = (n, w, p) => `${n.toLocaleString()} ${n === 1 ? w : (p || w + 's')}`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function dice(a, b) { // bigram similarity, tolerant of small spelling differences
  if (!a || !b) return 0; if (a === b) return 1; if (a.length < 2 || b.length < 2) return 0;
  const bg = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = bg(a), B = bg(b); let n = 0; for (const [g, c] of A) n += Math.min(c, B.get(g) || 0);
  return 2 * n / (a.length + b.length - 2);
}
const titleSim = (a, b) => Math.max(dice(norm(a), norm(b)), dice(norm(stripParen(a)), norm(stripParen(b))));
let toastT;
function toast(msg, ms = 3600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const saveData = !!(navigator.connection && navigator.connection.saveData);
const SLICE = 163840;          // bytes of a preview used to judge a candidate (about 10 s)
const READY_TARGET = saveData ? 3 : 5;
const REFS_PER_CRATE = saveData ? 4 : 8;
const COVER = saveData ? 250 : 500;

const I = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-8-4.9-8-11A4.5 4.5 0 0 1 12 6.6a4.5 4.5 0 0 1 8 2.9c0 6.1-8 11-8 11z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6"/></svg>',
};

/* ================= state ================= */
const KEY = 'liner:v2'; // storage keys keep the app's original name so existing data carries over
const defaults = () => ({ crates: [], likes: [], seen: {}, skipA: {}, dial: 0.5, auto: false, ml: { pos: [], neg: [], st: null } });
const S = (() => {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { }
  if (!v) try { // carry over playlists and saved finds from the first version
    const o = JSON.parse(localStorage.getItem('liner:v1') || 'null');
    if (o) v = { crates: o.crates || [], likes: (o.finds || []).map(f => ({ id: f.id, t: f.t, a: f.a, ai: f.ai, al: f.al, c: f.c, ts: f.ts || Date.now() })), dial: o.dial ?? 0.5 };
  } catch { }
  const d = defaults(); v = v || {};
  return { ...d, ...v, ml: { ...d.ml, ...(v.ml || {}) } };
})();
let saveT;
function save(now) {
  clearTimeout(saveT);
  const w = () => {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch { pruneCache(true); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { toast('Browser storage is full. Remove a playlist in Library to free space.'); } }
  };
  now ? w() : (saveT = setTimeout(w, 400));
}
addEventListener('pagehide', () => save(true));

/* ================= Deezer API: JSONP, rate-limited queue, cache ================= */
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
  Object.keys(localStorage).filter(k => k.startsWith('lc:')).forEach((k, i) => {
    let e = 0; try { e = JSON.parse(localStorage.getItem(k)).e; } catch { }
    if (all || e < Date.now() || i % 2) localStorage.removeItem(k);
  });
}
const Q = []; let active = 0, lastAt = 0, pumpT = 0;
function enqueue(fn, prio) { return new Promise((res, rej) => { prio ? Q.unshift({ fn, res, rej }) : Q.push({ fn, res, rej }); pump(); }); }
function pump() {
  while (active < 4 && Q.length) {
    const wait = lastAt + 120 - Date.now();
    // background tabs throttle timers hard; with only a few requests in flight, spacing is unnecessary
    if (wait > 0 && !(document.hidden && active < 2)) { if (!pumpT) pumpT = setTimeout(() => { pumpT = 0; pump(); }, wait); return; }
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
    const t = setTimeout(() => { s.remove(); window[cb] = () => { delete window[cb]; }; rej(new Error('timeout')); }, 12000);
    window[cb] = d => { clearTimeout(t); s.remove(); delete window[cb]; d && d.error ? rej(Object.assign(new Error(d.error.message || 'Deezer error'), { code: d.error.code })) : res(d); };
    s.onerror = () => { clearTimeout(t); s.remove(); delete window[cb]; rej(new Error('network')); };
    s.src = u; document.head.appendChild(s);
  });
}
// consecutive network failures; a run of them means we're offline, not out of music
const NET = { fails: 0 };
const netOK = () => { NET.fails = 0; }, netFail = () => { NET.fails++; };
const offline = () => NET.fails >= 5 || navigator.onLine === false;
async function dz(path, params = {}, prio) {
  for (let i = 0; ; i++) {
    try { const d = await enqueue(() => jsonp(path, params), prio); netOK(); return d; }
    catch (e) {
      if (e.code === undefined) netFail(); else netOK(); // a Deezer error reply still means we're online
      if (i < 3 && (e.code === 4 || (e.message === 'timeout' && !offline()))) { await sleep(1000 * (i + 1)); continue; }
      throw e;
    }
  }
}
async function dzc(path, params, ttl, map) {
  const k = path + '?' + new URLSearchParams(params);
  const hit = cget(k); if (hit !== undefined) return hit;
  const v = map(await dz(path, params)); cset(k, v, ttl); return v;
}
const mapTrack = t => ({ id: t.id, t: t.title_short || t.title || '', a: t.artist?.name || '', ai: t.artist?.id || 0, al: t.album?.title || '', c: t.album?.md5_image || t.md5_image || mdOf(t.album?.cover_medium), r: t.rank || 0 });
const mapArtist = a => ({ id: a.id, name: a.name, fans: a.nb_fan || 0, p: a.md5_image || mdOf(a.picture_medium) });
const api = {
  searchArtist: q => dzc('search/artist', { q, limit: 6 }, 168, d => (d.data || []).map(mapArtist)),
  searchTrack: (q, limit = 5) => dzc('search/track', { q, limit }, 168, d => (d.data || []).map(mapTrack)),
  related: id => dzc(`artist/${id}/related`, { limit: 30 }, 168, d => (d.data || []).map(mapArtist)),
  top: id => dzc(`artist/${id}/top`, { limit: 10 }, 72, d => (d.data || []).map(mapTrack)),
  track: id => dz(`track/${id}`, {}, true), // never cached: preview links expire
};
async function resolveArtist(name) {
  const r = await api.searchArtist(name); if (!r.length) return null;
  const n = norm(name);
  return r.find(a => norm(a.name) === n) || r.find(a => { const m = norm(a.name); return m && n && (m.startsWith(n) || n.startsWith(m)); }) || null;
}

/* ================= audio analysis (Web Worker) ================= */
const WORKER_SRC = `
const N=1024,H=512,B=40,NM=26;
let sr0=0,win,rev,cs,sn,mel,dct,edges;
function init(sr){
  if(sr===sr0)return; sr0=sr;
  win=new Float32Array(N);for(let i=0;i<N;i++)win[i]=.5-.5*Math.cos(2*Math.PI*i/N);
  rev=new Uint32Array(N);const bits=Math.log2(N);for(let i=0;i<N;i++){let r=0;for(let b=0;b<bits;b++)r|=((i>>b)&1)<<(bits-1-b);rev[i]=r}
  cs=new Float32Array(N/2);sn=new Float32Array(N/2);for(let i=0;i<N/2;i++){cs[i]=Math.cos(2*Math.PI*i/N);sn[i]=-Math.sin(2*Math.PI*i/N)}
  const h2m=f=>2595*Math.log10(1+f/700),m2h=m=>700*(Math.pow(10,m/2595)-1),lo=h2m(30),hi=h2m(Math.min(11000,sr/2));
  const p=[];for(let i=0;i<NM+2;i++)p.push(m2h(lo+(hi-lo)*i/(NM+1))*N/sr);
  mel=[];for(let m=0;m<NM;m++){const a=p[m],c=p[m+1],d=p[m+2],w=new Float32Array(N/2);for(let k=0;k<N/2;k++)w[k]=k<a||k>d?0:k<=c?(k-a)/((c-a)||1):(d-k)/((d-c)||1);mel.push(w)}
  dct=[];for(let i=0;i<13;i++){const r=new Float32Array(NM);for(let j=0;j<NM;j++)r[j]=Math.cos(Math.PI*i*(j+.5)/NM);dct.push(r)}
  edges=[];for(let b=0;b<=B;b++){edges.push(Math.max(1,Math.round(40*Math.pow(10000/40,b/B)*N/sr)))}
  for(let b=1;b<=B;b++)if(edges[b]<=edges[b-1])edges[b]=edges[b-1]+1;
}
function fft(re,im){
  for(let i=0;i<N;i++){const j=rev[i];if(j>i){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t}}
  for(let size=2;size<=N;size*=2){const half=size/2,step=N/size;
    for(let i=0;i<N;i+=size)for(let j=0;j<half;j++){const k=j*step,a=i+j,b=a+half,tr=re[b]*cs[k]-im[b]*sn[k],ti=re[b]*sn[k]+im[b]*cs[k];re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti}}
}
onmessage=e=>{const {id,pcm,sr,want}=e.data;try{
  init(sr);const nF=Math.max(1,Math.floor((pcm.length-N)/H)+1),K=N/2,binHz=sr/N;
  const re=new Float32Array(N),im=new Float32Array(N),mag=new Float32Array(K),prev=new Float32Array(K);
  const db=want.spec?new Float32Array(nF*B):null,onset=new Float32Array(nF);
  const mS=new Float64Array(13),mQ=new Float64Array(13),me=new Float64Array(NM);let nv=0,cS=0,cQ=0,roS=0,flS=0,rS=0,rQ=0,lo=0,md=0,hi=0,dbMax=-1e9;
  for(let f=0;f<nF;f++){const o=f*H;let e2=0;
    for(let i=0;i<N;i++){const x=pcm[o+i]||0;e2+=x*x;re[i]=x*win[i];im[i]=0}
    fft(re,im);let flux=0;
    for(let k=0;k<K;k++){const m=Math.hypot(re[k],im[k]);mag[k]=m;const lm=Math.log1p(10*m);if(lm>prev[k])flux+=lm-prev[k];prev[k]=lm}
    onset[f]=flux;
    if(db){for(let b=0;b<B;b++){let s=0;const a=edges[b],z=Math.min(K,edges[b+1]);for(let k=a;k<z;k++)s+=mag[k];const v=20*Math.log10(s/Math.max(1,z-a)+1e-9);db[f*B+b]=v;if(v>dbMax)dbMax=v}}
    if(!want.feat)continue;
    const rms=Math.sqrt(e2/N);if(rms<3e-4)continue;
    nv++;let pw=0,cen=0,l=0,mi=0,h=0,lgs=0;
    for(let k=1;k<K;k++){const p=mag[k]*mag[k]+1e-12,fq=k*binHz;pw+=p;cen+=fq*p;lgs+=Math.log(p);if(fq<150)l+=p;else if(fq<2000)mi+=p;else h+=p}
    let acc=0,ro=0;for(let k=1;k<K;k++){acc+=mag[k]*mag[k];if(acc>=.85*pw){ro=k*binHz;break}}
    const c=cen/pw/1000;cS+=c;cQ+=c*c;roS+=ro/1000;flS+=Math.exp(lgs/(K-1))/(pw/(K-1));
    const rd=20*Math.log10(rms);rS+=rd;rQ+=rd*rd;lo+=l/pw;md+=mi/pw;hi+=h/pw;
    for(let m=0;m<NM;m++){let s=0;const w=mel[m];for(let k=0;k<K;k++)if(w[k])s+=w[k]*mag[k]*mag[k];me[m]=Math.log10(s+1e-10)}
    for(let i=0;i<13;i++){let s=0;const r=dct[i];for(let j=0;j<NM;j++)s+=r[j]*me[j];mS[i]+=s;mQ[i]+=s*s}
  }
  let feat=null;
  if(want.feat&&nv>=20){
    const fr=sr/H,mean=x=>x/nv,sd=(s,q)=>Math.sqrt(Math.max(0,q/nv-(s/nv)*(s/nv)));
    let om=0;for(let f=0;f<nF;f++)om+=onset[f];om/=nF;let osd=0;for(let f=0;f<nF;f++)osd+=(onset[f]-om)**2;osd=Math.sqrt(osd/nF);
    let peaks=0;for(let f=1;f<nF-1;f++)if(onset[f]>onset[f-1]&&onset[f]>=onset[f+1]&&onset[f]>om+.5*osd)peaks++;
    const env=new Float32Array(nF);for(let f=0;f<nF;f++){let s=0,c=0;for(let j=Math.max(0,f-8);j<=Math.min(nF-1,f+8);j++){s+=onset[j];c++}env[f]=Math.max(0,onset[f]-s/c)}
    let a0=0;for(let f=0;f<nF;f++)a0+=env[f]*env[f];let best=0,bl=0,bs=-1;
    const lmin=Math.max(2,Math.round(60*fr/190)),lmax=Math.round(60*fr/60);
    for(let l=lmin;l<=lmax&&l<nF;l++){let s=0;for(let f=0;f+l<nF;f++)s+=env[f]*env[f+l];const bpm=60*fr/l,w=Math.exp(-.5*Math.pow(Math.log2(bpm/120),2));if(s*w>bs){bs=s*w;bl=l;best=s}}
    const bpm=bl?60*fr/bl:120,clar=a0>0?best/a0:0;
    feat=[];for(let i=0;i<13;i++)feat.push(mS[i]/nv);for(let i=0;i<13;i++)feat.push(sd(mS[i],mQ[i]));
    feat.push(mean(cS),sd(cS,cQ),mean(roS),mean(flS),mean(rS),sd(rS,rQ),mean(lo),mean(md),mean(hi),peaks/(nF/fr),bpm/100,clar);
    feat=feat.map(v=>Number.isFinite(v)?Math.round(v*1e4)/1e4:0);
  }
  let spec=null;
  if(db){spec=new Uint8Array(nF*B);const floor=dbMax-48;for(let i=0;i<db.length;i++)spec[i]=Math.max(0,Math.min(255,(db[i]-floor)/48*255))}
  postMessage({id,feat,spec,fr:sr/H,frames:nF,bands:B},spec?[spec.buffer]:[]);
}catch(err){postMessage({id,err:String(err&&err.message||err)})}};
`;
const DIM = 38;
let W = null, wid = 0; const WP = new Map();
function analyzePCM(pcm, sr, want) {
  if (!W) {
    W = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
    W.onmessage = e => { const p = WP.get(e.data.id); if (!p) return; WP.delete(e.data.id); e.data.err ? p.rej(new Error(e.data.err)) : p.res(e.data); };
    W.onerror = e => { for (const p of WP.values()) p.rej(new Error('analysis failed')); WP.clear(); W = null; e.preventDefault(); };
  }
  return new Promise((res, rej) => { const id = ++wid; WP.set(id, { res, rej }); W.postMessage({ id, pcm, sr, want }, [pcm.buffer]); });
}
const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
async function decode(bytes) { // decodeAudioData detaches its input, so it gets a copy
  const ctx = new OAC(1, 22050, 22050);
  const buf = await ctx.decodeAudioData(bytes.slice().buffer);
  const n = buf.length, ch = buf.numberOfChannels, out = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
  return { pcm: out, sr: buf.sampleRate };
}
const DATA = { bytes: 0 }; // audio downloaded this session, shown in Library
async function fetchBytes(url, range) {
  let r;
  try { r = await fetch(url, range ? { headers: { Range: range } } : undefined); netOK(); } catch (e) { netFail(); throw e; }
  if (!r.ok) throw Object.assign(new Error('http ' + r.status), { status: r.status });
  const total = +((r.headers.get('content-range') || '').split('/')[1] || 0) || +(r.headers.get('content-length') || 0);
  const bytes = new Uint8Array(await r.arrayBuffer());
  DATA.bytes += bytes.length;
  return { bytes, partial: r.status === 206, total };
}

/* A probe judges a track from the first slice of its preview. */
async function probe(tr) {
  const d = await api.track(tr.id);
  if (!d.preview) throw new Error('nopreview');
  const r = await fetchBytes(d.preview, `bytes=0-${SLICE - 1}`);
  let feat = null;
  try { const { pcm, sr } = await decode(r.bytes); feat = (await analyzePCM(pcm, sr, { feat: true })).feat; } catch { }
  return { url: d.preview, head: r.partial ? r.bytes : r.bytes, complete: !r.partial || r.bytes.length >= r.total, feat };
}
/* Realize downloads the rest of a chosen track and builds the visualizer spectrum. Memoized. */
function realize(item) {
  if (item.au) return Promise.resolve(item.au);
  if (item.rz) return item.rz;
  const rz = item.rz = (async () => {
    if (!item.pr) item.pr = probe(item.tr);
    const p = await item.pr;
    let bytes = p.head;
    if (!p.complete) {
      let rest = null;
      try { rest = await fetchBytes(p.url, `bytes=${p.head.length}-`); } catch { }
      if (rest && rest.partial) { bytes = new Uint8Array(p.head.length + rest.bytes.length); bytes.set(p.head); bytes.set(rest.bytes, p.head.length); }
      else if (rest) bytes = rest.bytes; // server sent the whole file
      else { // preview link expired: get a fresh one
        const d = await api.track(item.tr.id); if (!d.preview) throw new Error('nopreview');
        bytes = (await fetchBytes(d.preview)).bytes;
      }
    }
    if (!item.feat && p.feat) item.feat = p.feat;
    let viz = null;
    try { const { pcm, sr } = await decode(bytes); viz = await analyzePCM(pcm, sr, { spec: true, feat: !item.feat }); } catch { }
    if (!item.feat && viz && viz.feat) item.feat = viz.feat;
    const au = { url: URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })), viz };
    if (item.rz !== rz) { URL.revokeObjectURL(au.url); throw new Error('released'); }
    item.au = au; item.pr = null; // the slice is no longer needed
    return au;
  })();
  rz.catch(() => { if (item.rz === rz) { item.rz = null; item.pr = null; } });
  return rz;
}
function unrealize(item) { if (item.au) URL.revokeObjectURL(item.au.url); item.au = null; item.rz = null; item.pr = null; }

/* ================= taste model ================= */
function stAdd(v) { // running mean and variance over every analyzed track (Welford)
  if (!v) return; let st = S.ml.st;
  if (!st || st.m.length !== DIM) st = S.ml.st = { n: 0, m: Array(DIM).fill(0), q: Array(DIM).fill(0) };
  if (st.n >= 4000) return; st.n++;
  for (let i = 0; i < DIM; i++) { const d = v[i] - st.m[i]; st.m[i] += d / st.n; st.q[i] += d * (v[i] - st.m[i]); }
  lrDirty = true;
}
function zs(v) {
  const st = S.ml.st, out = new Float64Array(DIM);
  for (let i = 0; i < DIM; i++) { const sd = st && st.n > 2 ? Math.sqrt(st.q[i] / (st.n - 1)) : 1; out[i] = clamp((v[i] - (st ? st.m[i] : 0)) / (sd || 1), -4, 4); }
  return out;
}
function cos(a, b) { let d = 0, x = 0, y = 0; for (let i = 0; i < DIM; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; }
let LR = null, lrDirty = true, ZP = null, ZN = null;
function trainLR() { // small logistic regression, retrained whenever examples change
  lrDirty = false; LR = null;
  ZP = S.ml.pos.map(e => [zs(e.v), e.w]); ZN = S.ml.neg.map(e => [zs(e.v), e.w]);
  if (ZP.length < 5 || ZN.length < 5) return;
  const X = [...ZP.map(([z, w]) => [z, 1, w]), ...ZN.map(([z, w]) => [z, 0, w])];
  const sp = ZP.reduce((s, e) => s + e[1], 0), sn = ZN.reduce((s, e) => s + e[1], 0);
  const w = new Float64Array(DIM); let b = 0;
  for (let ep = 0; ep < 120; ep++) {
    const lr = 0.05 / (1 + ep * 0.03);
    for (const [x, y, sw] of X) {
      let s = b; for (let i = 0; i < DIM; i++) s += w[i] * x[i];
      const g = (1 / (1 + Math.exp(-s)) - y) * sw * (y ? (sp + sn) / (2 * sp) : (sp + sn) / (2 * sn));
      for (let i = 0; i < DIM; i++) w[i] -= lr * (g * x[i] + 0.01 * w[i]);
      b -= lr * g;
    }
  }
  LR = { w, b };
}
function audioScore(feat) {
  if (!feat || !S.ml.pos.length) return null;
  if (lrDirty) trainLR();
  const z = zs(feat);
  const topk = (list, k) => { const s = list.map(([v, w]) => cos(z, v) * Math.min(1.5, w)).sort((a, b) => b - a).slice(0, k); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0; };
  const knn = clamp((topk(ZP, 5) - 0.6 * topk(ZN, 3) + 1) / 2, 0, 1);
  if (!LR) return knn;
  let s = LR.b; for (let i = 0; i < DIM; i++) s += LR.w[i] * z[i];
  return 0.5 * knn + 0.5 / (1 + Math.exp(-s));
}
function addExample(kind, id, v, w, src) {
  if (!v) return;
  const L = S.ml[kind], sr = src || kind;
  const i = L.findIndex(e => e.id === id && e.src === sr); if (i >= 0) L.splice(i, 1);
  L.push({ id, v, w, src: sr });
  const cap = kind === 'pos' ? 500 : 400;
  while (L.length > cap) { const j = L.findIndex(e => e.src === 'done'); L.splice(j >= 0 ? j : 0, 1); }
  lrDirty = true; save();
}
function dropExample(kind, id, src) {
  const n = S.ml[kind].length;
  S.ml[kind] = S.ml[kind].filter(e => !(e.id === id && (!src || e.src === src)));
  if (S.ml[kind].length !== n) { lrDirty = true; save(); }
}

/* learn the sound of imported playlists from short slices, in the background */
let learning = false;
async function learnRefs() {
  if (learning || !started) return; learning = true;
  try {
    for (const c of S.crates) {
      let have = S.ml.pos.filter(e => e.src === 'ref' && e.crate === c.id).length;
      if (have >= REFS_PER_CRATE || (c.refTried || 0) >= REFS_PER_CRATE * 3) continue;
      const counts = new Map(); for (const r of c.tracks) counts.set(norm(r[1]), (counts.get(norm(r[1])) || 0) + 1);
      const rows = c.tracks.map(r => [r, Math.random()]).sort((a, b) => (counts.get(norm(b[0][1])) - counts.get(norm(a[0][1]))) || a[1] - b[1]).map(x => x[0]);
      const usedA = new Set(S.ml.pos.filter(e => e.src === 'ref' && e.crate === c.id).map(e => e.an));
      for (const [t, a] of rows) {
        if (have >= REFS_PER_CRATE || (c.refTried || 0) >= REFS_PER_CRATE * 3 || !S.crates.includes(c)) break;
        if (usedA.has(norm(a))) continue; usedA.add(norm(a));
        while (R.length < 2 && !G.exhausted && !G.err) await sleep(1500); // the feed comes first
        c.refTried = (c.refTried || 0) + 1;
        try {
          let tr = null;
          if (t) tr = (await api.searchTrack(`artist:"${a}" track:"${t}"`, 3)).find(x => dice(norm(x.a), norm(a)) > .6) || null;
          if (!tr) { const ar = await resolveArtist(a); if (ar) tr = (await api.top(ar.id))[0] || null; }
          if (!tr) continue;
          const p = await probe(tr);
          if (!p.feat || !S.crates.includes(c)) continue;
          stAdd(p.feat);
          S.ml.pos.push({ id: tr.id, v: p.feat, w: 1, src: 'ref', crate: c.id, an: norm(a) }); lrDirty = true; have++;
        } catch { }
      }
      save();
    }
  } finally { learning = false; }
}

/* ================= taste graph & candidates ================= */
function tasteMap() {
  const m = new Map();
  const add = (name, w, id) => { const n = norm(name); if (!n) return; const e = m.get(n) || { name, n, w: 0, id: 0 }; e.w += w; if (id) e.id = id; m.set(n, e); };
  for (const c of S.crates) for (const [, a, x] of c.tracks) { add(a, 1); if (x) for (const o of x) add(o, .4); }
  for (const l of S.likes) add(l.a, 3, l.ai);
  return m;
}
const hasTaste = () => S.crates.some(c => c.tracks.length) || S.likes.length > 0;
/* Without a playlist the feed starts from what's charting on Deezer (overall plus a few random
   genres) and leans toward your likes as they come in. */
let COLD = null;
const coldMode = () => !S.crates.some(c => c.tracks.length) && S.likes.length < 8;
async function loadCold() {
  if (COLD) return COLD;
  // the overall track chart plus genre charts for a random handful of music genres
  // (Deezer's artist chart mixes in audiobooks and kids' radio plays, so it isn't used)
  const MUSIC = [132, 116, 152, 113, 165, 85, 106, 466, 144, 129, 464, 169, 2, 16, 153, 75, 197];
  const pick = MUSIC.map(g => [g, Math.random()]).sort((a, b) => a[1] - b[1]).slice(0, 6).map(x => x[0]);
  const artistsOf = d => ((d && d.data) || []).map(t => t.artist).filter(Boolean).map(mapArtist);
  const lists = await Promise.all([
    dzc('chart/0/tracks', { limit: 60 }, 12, artistsOf).then(l => l.map(a => [a, 'chart', 1])),
    ...pick.map(g => dzc(`editorial/${g}/charts`, { limit: 20 }, 12, d => artistsOf(d && d.tracks)).then(l => l.map(a => [a, 'g' + g, .6])).catch(() => [])),
  ]);
  const m = new Map(); for (const l of lists) for (const [a, grp, w] of l) if (!isKids(a.name) && !m.has(a.id)) m.set(a.id, { name: a.name, n: norm(a.name), id: a.id, w, grp, cold: true });
  if (!m.size) throw new Error('chart');
  COLD = [...m.values()];
  return COLD;
}
function seedList() {
  const own = [...tasteMap().values()].map(e => ({ ...e, w: Math.log2(1 + e.w) }));
  if (coldMode() && COLD) { const have = new Set(own.map(s => s.n)); for (const c of COLD) if (!have.has(c.n)) own.push({ ...c }); }
  return own.sort((a, b) => b.w - a.w).slice(0, 90);
}
const G = { viaUse: new Map(), gen: 0, pool: new Map(), used: new Set(), knownIds: new Set(), shownA: new Set(), cands: [], busy: null, exhausted: false, err: false };
function resetGraph() { G.gen++; G.pool.clear(); G.used.clear(); G.cands = []; G.exhausted = false; G.err = false; G.busy = null; }
const popOf = fans => clamp((Math.log10(fans + 1) - 3) / 3.5, 0, 1); // 1k fans -> 0, about 3M -> 1
// The dial's middle already favours well-known artists; the far right flips to obscure ones.
function dialFactor(fans) { return Math.pow(.1 + popOf(fans), 4 * (.75 - S.dial)); }
const minFans = () => S.dial <= .5 ? (coldMode() ? 150000 : 30000) : S.dial <= .7 ? 3000 : 0;
function wsample(items, k) {
  const keyed = items.map(it => ({ it, key: Math.pow(Math.random(), 1 / Math.max(.01, it.w)) })).sort((a, b) => b.key - a.key);
  const out = [], grps = new Set();
  for (const { it } of keyed) { const g = it.grp || it.n; if (!grps.has(g)) { grps.add(g); out.push(it); if (out.length >= k) return out; } }
  for (const { it } of keyed) { if (!out.includes(it)) { out.push(it); if (out.length >= k) break; } }
  return out;
}
async function feedSeed(s, gen) {
  G.used.add(s.n);
  let id = s.id;
  if (!id) { let a; try { a = await resolveArtist(s.name); } catch { G.used.delete(s.n); return 'err'; } if (!a) return 'none'; id = s.id = a.id; }
  G.knownIds.add(id);
  let rel; try { rel = await api.related(id); } catch { G.used.delete(s.n); return 'err'; }
  if (gen !== G.gen) return 'stale';
  rel.forEach((r, i) => {
    const c = G.pool.get(r.id) || { a: r, score: 0, coldScore: 0, via: new Map() };
    const add = s.w * (1 - i / 36); c.score += add; c.via.set(s.name, (c.via.get(s.name) || 0) + add);
    if (s.cold) c.coldScore += add;
    G.pool.set(r.id, c);
  });
  return 'ok';
}
const isLiked = id => S.likes.some(l => l.id === id);
function walkSeeds() {
  const out = [];
  for (const s of SL) {
    const a = s.item.artist; if (!a || S.skipA[a.id]) continue;
    const n = norm(a.name); if (G.used.has(n) || out.some(o => o.n === n)) continue;
    out.push({ name: a.name, n, id: a.id, w: isLiked(s.item.tr.id) ? 1 : .4, grp: 'walk:' + n });
  }
  return out;
}
const SPOKEN = /\b(folge|teil|kapitel|chapter|episode|h\u00f6rspiel|h\u00f6rbuch|audiobook|audio book|podcast|t\u00fcr)\b\s*\d*|^\d+\s*[-\u2013.:]\s/i;
const isSpoken = t => SPOKEN.test(t.t) || SPOKEN.test(t.al || '') || isKids(t.al || '');
const KIDS = /kinder|\bkids\b|\bdisney\b|children|lullab|wiegenlied|schlaflied|nursery|bibi blocksberg|bibi und tina|benjamin bl\u00fcmchen|schl\u00fcmpfe|spongebob|baby ?shark|h\u00f6rspiel|h\u00f6rbuch/i;
function isKids(name) { return KIDS.test(name || ''); }
// holiday songs only during the holidays
const XMAS = /christmas|xmas|weihnacht|navidad|no\u00ebl|jingle|santa|let it snow|winter wonderland|mistletoe|sleigh|rudolph|silent night|feliz navidad/i;
const holidays = () => { const d = new Date(); return d.getMonth() === 11 && d.getDate() <= 26; };
const offSeason = t => !holidays() && (XMAS.test(t.t) || XMAS.test(t.al || ''));
function digMore(n = 6) {
  if (G.busy) return G.busy;
  const gen = G.gen;
  const run = (async () => {
    let added = 0, errs = 0, oks = 0;
    if (coldMode()) await loadCold().catch(() => { errs++; });
    if (gen !== G.gen) return 0;
    const known = new Set(tasteMap().keys());
    for (let round = 0; round < 3 && added < n && !offline(); round++) {
      let avail = seedList().filter(s => !G.used.has(s.n));
      // once your own artists run low, keep walking outward from songs already shown (and not skipped)
      if (avail.length < 3) avail = avail.concat(walkSeeds());
      const fresh = [...G.pool.values()].filter(c => !G.shownA.has(c.a.id)).length;
      if (avail.length && (round === 0 || fresh < n * 4)) {
        const r = await Promise.all(wsample(avail, round ? 5 : 3).map(s => feedSeed(s, gen)));
        errs += r.filter(x => x === 'err').length; oks += r.filter(x => x === 'ok').length;
      }
      if (gen !== G.gen) return 0;
      // Score: strongest link plus a damped share of the others, so one dense cluster can't take
      // over; at most two picks per batch may hang off the same artist of yours.
      const perVia = new Map();
      const eligible = [...G.pool.values()].filter(c => !G.shownA.has(c.a.id) && !G.knownIds.has(c.a.id) && !known.has(norm(c.a.name)));
      const popular = eligible.filter(c => c.a.fans >= minFans());
      // the popularity floor only applies while it leaves enough to choose from (niche tastes stay playable)
      const cand = (popular.length >= Math.max(3, n - added) ? popular : eligible)
        .map(c => { const vs = [...c.via.values()], mx = Math.max(...vs), sum = vs.reduce((a, b) => a + b, 0);
          const top = [...c.via.entries()].sort((a, b) => b[1] - a[1])[0][0];
          return { c, s: (mx + .35 * (sum - mx)) * dialFactor(c.a.fans) * Math.pow(.45, S.skipA[c.a.id] || 0) * Math.pow(.55, G.viaUse.get(top) || 0) * (.8 + Math.random() * .4) }; })
        .sort((x, y) => y.s - x.s)
        .filter(({ c }) => { const top = [...c.via.entries()].sort((a, b) => b[1] - a[1])[0][0]; const k = perVia.get(top) || 0; if (k >= 2) return false; perVia.set(top, k + 1); return true; })
        .slice(0, n - added);
      if (!cand.length && !avail.length) { G.exhausted = true; break; }
      const got = await Promise.all(cand.map(async ({ c, s }) => {
        G.shownA.add(c.a.id);
        let tops; try { tops = await api.top(c.a.id); } catch { errs++; G.shownA.delete(c.a.id); return null; }
        oks++;
        // the artist's best-known songs first (Deezer orders top tracks by popularity)
        if (isKids(c.a.name) || tops.slice(0, 5).filter(isSpoken).length >= 2) return null; // spoken word or kids
        const pick = tops.filter(t => t.ai === c.a.id && !S.seen[t.id] && !isLiked(t.id) && !isSpoken(t) && !offSeason(t)).slice(0, 4);
        const t = pick[Math.random() < .7 ? 0 : Math.random() * Math.min(3, pick.length) | 0];
        return t ? { tr: t, artist: c.a, via: [...c.via.entries()].sort((a, b) => b[1] - a[1]).map(v => v[0]), g: s, cold: c.coldScore >= c.score - 1e-9 } : null;
      }));
      if (gen !== G.gen) return 0;
      for (const x of got) if (x) { G.cands.push(x); added++; }
    }
    if (gen === G.gen && added === 0 && (offline() || (errs > 0 && oks === 0))) G.err = true;
    return added;
  })();
  G.busy = run.finally(() => { if (G.gen === gen) G.busy = null; });
  return G.busy;
}

/* ready buffer: probed candidates waiting for a slide */
const R = []; let filling = null, fillGen = -1, retryT = 0, emptyFills = 0;
const readyTarget = () => started ? READY_TARGET : 1; // before the first tap, fetch as little as possible
function fill() {
  if (filling && fillGen === G.gen) return filling;
  const gen = fillGen = G.gen;
  const run = (async () => {
    let fails = 0, got = 0;
    while (R.length < readyTarget() && gen === G.gen) {
      if (offline()) { G.err = true; break; }
      if (!G.cands.length) {
        if (G.exhausted || G.err) break;
        await digMore(); if (gen !== G.gen) return;
        if (!G.cands.length) break;
      }
      const batch = G.cands.splice(0, Math.min(2, readyTarget() - R.length));
      const res = await Promise.all(batch.map(async c => {
        try { c.pr = probe(c.tr); const p = await c.pr; c.feat = p.feat; stAdd(p.feat); return c; }
        catch { c.pr = null; return null; }
      }));
      if (gen !== G.gen) { res.forEach(c => c && unrealize(c)); return; }
      for (const c of res) if (c) { R.push(c); fails = 0; got++; } else fails++;
      if (fails >= 8) { G.err = true; break; }
      ensureAhead(true);
    }
    if (!G.err) {
      emptyFills = got ? 0 : emptyFills + 1;
      if (emptyFills >= 6 && !G.cands.length) G.exhausted = true; // never spin without progress
    }
  })();
  filling = run.finally(() => {
    if (fillGen === gen) filling = null;
    ensureAhead(); updateLoader();
    if (G.err && !retryT) retryT = setTimeout(() => { retryT = 0; if (G.err) retryNow(); }, 15000);
  });
  updateLoader();
  return filling;
}
function choose() {
  if (!R.length) return null;
  const gmax = Math.max(...R.map(c => c.g)) || 1;
  const nEx = S.ml.pos.length + S.ml.neg.length;
  const wa = S.ml.pos.length ? Math.min(.35, .1 + nEx / 100) : 0, wn = .25;
  // variety: compare each candidate with the last few songs placed in the feed
  const recent = SL.slice(-4).map(s => s.item);
  const recentZ = recent.filter(i => i.feat).map(i => zs(i.feat));
  const viaCount = new Map(); for (const s of SL.slice(-8)) { const v = s.item.via && s.item.via[0]; if (v) viaCount.set(v, (viaCount.get(v) || 0) + 1); }
  const explore = Math.random() < .1; // keep some surprise
  let best = null, bs = -Infinity;
  for (const c of R) {
    const as = audioScore(c.feat);
    let nov = .5;
    if (c.feat && recentZ.length) { const z = zs(c.feat); nov = (1 - Math.max(...recentZ.map(r => cos(z, r)))) / 2; }
    let s = (1 - wa - wn) * (c.g / gmax) + wa * (as ?? .5) + wn * nov;
    if (c.via) s *= Math.pow(.4, viaCount.get(c.via[0]) || 0);
    if (explore) s = Math.random();
    if (s > bs) { bs = s; best = c; }
  }
  R.splice(R.indexOf(best), 1);
  if (best.via && best.via[0]) G.viaUse.set(best.via[0], (G.viaUse.get(best.via[0]) || 0) + 1);
  return best;
}
function flushReady() { R.splice(0).forEach(unrealize); }

/* ================= slides ================= */
const feed = $('#feed'), loaderEl = $('#loader');
const SL = []; let cur = -1, started = false;
function slideHTML(item) {
  const t = item.tr, q = encodeURIComponent(`${t.a} ${t.t}`);
  const via = (item.via || []).slice(0, 2), more = (item.via || []).length - via.length;
  const liked = isLiked(t.id);
  return `<img class="bg" src="${coverUrl(t.c, 56)}" alt="" crossorigin="anonymous" decoding="async">
    <div class="shade"></div>
    <div class="stage" aria-label="Tap to pause or play, double tap to like">
      <img class="cover" src="${coverUrl(t.c, COVER)}" alt="Cover of ${esc(t.al)}" crossorigin="anonymous" decoding="async">
      <span class="paused" aria-hidden="true">${I.play}</span>
    </div>
    <div class="meta">
      <h2>${esc(t.t)}</h2>
      <p class="artist">${esc(t.a)}</p>
      ${via.length ? `<p class="why">Near <b>${via.map(esc).join('</b> and <b>')}</b>${item.cold ? ', popular right now' : more > 0 ? ` and ${more} more of yours` : ''}</p>` : item.label ? `<p class="why">${esc(item.label)}</p>` : ''}
      <div class="acts">
        <button class="like" aria-pressed="${liked}">${I.heart}<span>${liked ? 'Liked' : 'Like'}</span></button>
        <button class="full" aria-expanded="false">Full song</button>
      </div>
      <div class="outs" hidden>
        <a href="https://open.spotify.com/search/${q}" target="_blank" rel="noopener">Spotify</a>
        <a href="https://music.apple.com/search?term=${q}" target="_blank" rel="noopener">Apple Music</a>
        <a href="https://music.youtube.com/search?q=${q}" target="_blank" rel="noopener">YouTube Music</a>
        <a href="https://www.deezer.com/track/${t.id}" target="_blank" rel="noopener">Deezer</a>
      </div>
    </div>
    <div class="prog"><i></i></div>`;
}
function makeSlide(item, at = SL.length) {
  const el = document.createElement('section');
  el.className = 'slide'; el.setAttribute('aria-roledescription', 'song');
  el.setAttribute('aria-label', `${item.tr.t} by ${item.tr.a}`);
  el.innerHTML = slideHTML(item);
  const s = { item, el, maxT: 0, ended: false, logged: false, col: null };
  feed.insertBefore(el, SL[at] ? SL[at].el : loaderEl);
  SL.splice(at, 0, s);
  if (cur >= at) cur++; // the slide (or loader) on screen moved down one place
  S.seen[item.tr.id] = Date.now();
  const ks = Object.keys(S.seen); if (ks.length > 5000) ks.sort((a, b) => S.seen[a] - S.seen[b]).slice(0, 1000).forEach(k => delete S.seen[k]);
  const img = $('.cover', el);
  const pal = () => { s.col = palette(img); if (VZ.s === s) VZ.col = s.col; };
  img.complete && img.naturalWidth ? pal() : img.addEventListener('load', pal, { once: true });
  io.observe(el);
  return s;
}
function ensureAhead(noFill) {
  // sitting on the loader: the first ready song takes its place
  if (cur >= SL.length && R.length) {
    const s = makeSlide(choose()), i = SL.indexOf(s);
    activate(i, true); snapTo(i, true);
    return;
  }
  const ahead = started ? 2 : 1;
  while (R.length && SL.length - 1 - Math.max(cur, 0) < ahead) makeSlide(choose());
  if (started) { const nx = SL[cur + 1]; if (nx) realize(nx.item).catch(() => { }); } // next song ready to play instantly
  if (!noFill && R.length < readyTarget() && (G.cands.length || (!G.exhausted && !G.err))) fill();
  updateLoader();
}
function updateLoader() {
  const msg = $('#lmsg'), retry = $('#lretry');
  let t, idle = true; retry.hidden = true;
  if (G.err) { t = "Can't reach Deezer right now. Check your connection."; retry.hidden = false; }
  else if (G.exhausted && !R.length && !G.cands.length && !filling) t = "That's every artist near your music for now. Add another playlist or like a few more songs to open new paths.";
  else { t = 'Finding the next song'; idle = false; }
  msg.textContent = t; loaderEl.classList.toggle('idle', idle);
}
function retryNow() { G.err = false; NET.fails = 0; clearTimeout(retryT); retryT = 0; emptyFills = 0; fill(); }
$('#lretry').onclick = retryNow;
addEventListener('online', () => { if (G.err) retryNow(); });
function snapTo(i, instant) {
  feed.scrollTo({ top: i * feed.clientHeight, behavior: instant || document.hidden || reduced.matches ? 'instant' : 'smooth' });
}
const io = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) {
    const i = e.target === loaderEl ? SL.length : SL.findIndex(s => s.el === e.target);
    if (i >= 0) activate(i);
  }
}, { root: feed, threshold: 0.6 });
io.observe(loaderEl);
feed.addEventListener('scrollend', () => { const i = Math.round(feed.scrollTop / feed.clientHeight); if (i !== cur && i >= 0 && i <= SL.length) activate(i); });

function leave(s, viaAuto) {
  if (!s || s.logged || !started) return;
  const t = s.item.tr, liked = isLiked(t.id);
  if (!liked && !viaAuto && !s.ended && s.maxT > 0.3 && s.maxT < 7 && s.item.via) {
    s.logged = true; // a quick skip
    addExample('neg', t.id, s.item.feat, 1);
    S.skipA[t.ai] = (S.skipA[t.ai] || 0) + 1;
  } else if (!liked && s.ended && !S.auto && s.item.via) {
    s.logged = true; // listened all the way through by choice
    addExample('pos', t.id, s.item.feat, .3, 'done');
  }
}
function activate(i, viaAuto) {
  if (i === cur) return;
  const prev = SL[cur];
  if (prev) { leave(prev, viaAuto); prev.el.classList.remove('is-paused'); }
  cur = i;
  if (i >= SL.length) { P.tok++; P.audio.pause(); P.s = null; placeViz(null); ensureAhead(); return; }
  const s = SL[i];
  s.maxT = 0; s.ended = false;
  placeViz(s);
  if (started) playSlide(s);
  ensureAhead();
  // keep memory and data bounded: release audio far from the current slide
  SL.forEach((x, j) => { if ((j < i - 2 || j > i + 2) && (x.item.au || x.item.rz)) unrealize(x.item); });
  if (started && !learning) setTimeout(learnRefs, 4000);
  save();
}
async function playSlide(s) {
  const my = ++P.tok;
  P.s = s; setMedia(s);
  try {
    const au = await realize(s.item);
    if (my !== P.tok) return;
    if (P.audio.src !== au.url) P.audio.src = au.url;
    P.audio.currentTime = 0;
    await P.audio.play();
  } catch (e) {
    if (my !== P.tok) return;
    if (e && e.name === 'NotAllowedError') { s.el.classList.add('is-paused'); return; }
    if (e && (e.name === 'AbortError' || e.message === 'released')) return;
    toast(e && e.message === 'nopreview' ? 'No preview for this one. Skipping.' : 'This preview did not load. Skipping.');
    setTimeout(() => { if (P.tok === my) advance(true); }, 900);
  }
}
function advance(viaAuto) { const j = Math.min(cur + 1, SL.length); if (j === cur) return; activate(j, viaAuto); snapTo(j); }
function back() { if (cur > 0) { const j = cur - 1; activate(j); snapTo(j); } }

/* ================= player ================= */
const P = { audio: new Audio(), tok: 0, s: null };
P.audio.preload = 'auto';
P.audio.addEventListener('timeupdate', () => {
  const s = P.s; if (!s || !P.audio.src.startsWith('blob:')) return;
  const t = P.audio.currentTime; if (t > s.maxT) s.maxT = t;
  const bar = $('.prog i', s.el); if (bar) bar.style.width = (t / (P.audio.duration || 30) * 100) + '%';
});
P.audio.addEventListener('ended', () => {
  const s = P.s; if (!s || !P.audio.src.startsWith('blob:')) return;
  s.ended = true;
  if (S.auto) advance(true);
  else { leave(s, false); P.audio.currentTime = 0; P.audio.play().catch(() => { }); }
});
const syncPaused = () => { if (P.s) P.s.el.classList.toggle('is-paused', P.audio.paused && started); };
P.audio.addEventListener('play', syncPaused);
P.audio.addEventListener('pause', syncPaused);
function togglePlay() { if (!P.s) return; P.audio.paused ? P.audio.play().catch(() => { }) : P.audio.pause(); }
function setMedia(s) {
  if (!('mediaSession' in navigator)) return;
  const t = s.item.tr;
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.t, artist: t.a, album: t.al, artwork: [{ src: coverUrl(t.c, 500), sizes: '500x500', type: 'image/jpeg' }] }); } catch { }
}
if ('mediaSession' in navigator) {
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { } };
  h('play', () => P.audio.play()); h('pause', () => P.audio.pause());
  h('nexttrack', () => advance(false)); h('previoustrack', back);
}
// a silent clip played inside the first tap unlocks audio for later automatic playback (iOS)
let SILENT = '';
function unlockAudio() {
  if (!SILENT) {
    const n = 800, b = new Uint8Array(44 + n), v = new DataView(b.buffer), w = (o, s) => [...s].forEach((c, i) => b[o + i] = c.charCodeAt(0));
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true); b.fill(128, 44);
    let s = ''; b.forEach(x => s += String.fromCharCode(x)); SILENT = 'data:audio/wav;base64,' + btoa(s);
  }
  P.audio.src = SILENT; P.audio.play().catch(() => { });
}

/* ================= visualizer: record grooves that move with the music ================= */
const cv = document.createElement('canvas'); cv.className = 'viz'; cv.setAttribute('aria-hidden', 'true');
const cx = cv.getContext('2d');
const VZ = { s: null, col: null, lv: new Float32Array(40), w: 0, h: 0, dpr: 1, ox: 0, oy: 0, r0: 0 };
function placeViz(s) {
  VZ.s = s; VZ.lv.fill(0);
  if (!s) { cv.remove(); return; }
  s.el.insertBefore(cv, $('.stage', s.el));
  VZ.col = s.col; sizeViz();
}
function sizeViz() {
  const s = VZ.s; if (!s) return;
  const r = s.el.getBoundingClientRect(), c = $('.stage', s.el).getBoundingClientRect();
  if (!r.width) return;
  VZ.dpr = Math.min(devicePixelRatio || 1, matchMedia('(pointer:coarse)').matches ? 1.5 : 2);
  cv.width = Math.round(r.width * VZ.dpr); cv.height = Math.round(r.height * VZ.dpr);
  VZ.w = cv.width; VZ.h = cv.height;
  VZ.ox = (c.left - r.left + c.width / 2) * VZ.dpr; VZ.oy = (c.top - r.top + c.height / 2) * VZ.dpr; VZ.r0 = c.width / 2 * VZ.dpr;
}
addEventListener('resize', debounce(() => { if (cur >= 0) feed.scrollTo({ top: cur * feed.clientHeight, behavior: 'instant' }); sizeViz(); }, 120));
const FALLBACK = [[242, 180, 58], [120, 130, 255]];
function palette(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data, bins = Array.from({ length: 12 }, (_, i) => ({ i, w: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      if (mx - mn < .04) continue;
      let h = mx === r ? (gg - b) / (mx - mn) : mx === gg ? 2 + (b - r) / (mx - mn) : 4 + (r - gg) / (mx - mn); h = (h * 60 + 360) % 360;
      const sat = (mx - mn) / mx, wt = sat * sat * mx, bn = bins[Math.floor(h / 30) % 12]; bn.w += wt; bn.r += r * wt; bn.g += gg * wt; bn.b += b * wt;
    }
    const top = bins.filter(b => b.w > 0).sort((a, b) => b.w - a.w);
    if (!top.length) return FALLBACK;
    const vivid = b => { const r = b.r / b.w, g2 = b.g / b.w, bl = b.b / b.w, k = .95 / (Math.max(r, g2, bl) || 1); return [r * k * 255, g2 * k * 255, bl * k * 255].map(Math.round); };
    const second = top.find(b => Math.min(Math.abs(b.i - top[0].i), 12 - Math.abs(b.i - top[0].i)) >= 2 && b.w > top[0].w * .12);
    return [vivid(top[0]), second ? vivid(second) : FALLBACK[0]];
  } catch { return FALLBACK; }
}
function drawViz(time) {
  requestAnimationFrame(drawViz);
  const s = VZ.s; if (!s || document.hidden || !VZ.w) return;
  const viz = s.item.au && s.item.au.viz, playing = P.s === s && !P.audio.paused && P.audio.src.startsWith('blob:');
  const B = 40, lv = VZ.lv, still = reduced.matches;
  if (viz && viz.spec && playing && !still) {
    const f = Math.min(viz.frames - 1, Math.max(0, Math.floor(P.audio.currentTime * viz.fr)));
    for (let b = 0; b < B; b++) { const tg = viz.spec[f * viz.bands + b] / 255; lv[b] += (tg - lv[b]) * (tg > lv[b] ? .55 : .12); }
  } else for (let b = 0; b < B; b++) lv[b] += (.2 - lv[b]) * (still ? 1 : .06);
  const { w, h, ox, oy, r0, dpr } = VZ;
  cx.clearRect(0, 0, w, h);
  const [c1, c2] = VZ.col || FALLBACK;
  let bass = 0; for (let b = 0; b < 6; b++) bass += lv[b]; bass /= 6;
  const g = cx.createRadialGradient(ox, oy, r0 * .6, ox, oy, r0 * (1.9 + bass * .5));
  g.addColorStop(0, `rgba(${c1},${.18 + bass * .35})`); g.addColorStop(1, `rgba(${c1},0)`);
  cx.fillStyle = g; cx.fillRect(0, 0, w, h);
  const far = Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy)), start = r0 * 1.1, rings = 30, t = still ? 0 : time / 1000;
  for (let i = 0; i < rings; i++) {
    const fr = i / (rings - 1), r = start + (far - start) * Math.pow(fr, 1.25);
    const e = lv[Math.min(B - 1, Math.floor(fr * B))];
    const amp = e * e * r0 * .2 * (1 - fr * .45) + bass * r0 * .03;
    const lobes = 3 + (i % 5), ph = t * (.35 + i * .045) * (i % 2 ? 1 : -1);
    const mix = k => Math.round(c1[k] + (c2[k] - c1[k]) * fr);
    cx.strokeStyle = `rgba(${mix(0)},${mix(1)},${mix(2)},${.1 + .55 * e * (1 - fr * .5)})`;
    cx.lineWidth = (.8 + 2.6 * e) * dpr;
    cx.beginPath();
    for (let k = 0; k <= 96; k++) {
      const a = k / 96 * Math.PI * 2, rr = r + amp * Math.sin(lobes * a + ph) * (.6 + .4 * Math.sin(a * 2 - ph * .7));
      const x = ox + rr * Math.cos(a), y = oy + rr * Math.sin(a);
      k ? cx.lineTo(x, y) : cx.moveTo(x, y);
    }
    cx.stroke();
  }
}
requestAnimationFrame(drawViz);

/* ================= likes ================= */
function toggleLike(s, forceOn) {
  const t = s.item.tr, on = isLiked(t.id);
  if (on && forceOn) return;
  if (on) { S.likes = S.likes.filter(l => l.id !== t.id); dropExample('pos', t.id, 'like'); }
  else {
    S.likes.unshift({ id: t.id, t: t.t, a: t.a, ai: t.ai, al: t.al, c: t.c, ts: Date.now() });
    addExample('pos', t.id, s.item.feat, 2, 'like'); dropExample('neg', t.id);
    if (S.skipA[t.ai]) delete S.skipA[t.ai];
  }
  save(); syncLikes(t.id);
}
function syncLikes(id) {
  for (const s of SL) if (s.item.tr.id === id) {
    const on = isLiked(id), b = $('.like', s.el);
    b.setAttribute('aria-pressed', on); b.querySelector('span').textContent = on ? 'Liked' : 'Like';
  }
}
function burst(s) {
  if (reduced.matches) return;
  const b = document.createElement('span'); b.className = 'burst'; b.innerHTML = I.heart;
  $('.stage', s.el).appendChild(b); setTimeout(() => b.remove(), 750);
}

/* slide interactions */
let tapT = 0, tapS = null;
feed.addEventListener('click', e => {
  const el = e.target.closest('.slide'); if (!el || el === loaderEl) return;
  const s = SL.find(x => x.el === el); if (!s) return;
  if (e.target.closest('.like')) { toggleLike(s); if (isLiked(s.item.tr.id)) burst(s); return; }
  const full = e.target.closest('.full');
  if (full) { const o = $('.outs', el); o.hidden = !o.hidden; full.setAttribute('aria-expanded', !o.hidden); return; }
  if (e.target.closest('.stage')) {
    if (tapT && tapS === s) { clearTimeout(tapT); tapT = 0; toggleLike(s, true); burst(s); return; }
    tapS = s; clearTimeout(tapT);
    tapT = setTimeout(() => { tapT = 0; if (started && SL[cur] === s) togglePlay(); }, 260);
  }
});
document.addEventListener('keydown', e => {
  if (!started || $('#sheet').open || e.metaKey || e.ctrlKey || e.altKey || (e.target.closest && e.target.closest('input,textarea'))) return;
  const k = e.key;
  if (k === 'ArrowDown' || k === 'j' || k === 'PageDown') { e.preventDefault(); advance(false); }
  else if (k === 'ArrowUp' || k === 'k' || k === 'PageUp') { e.preventDefault(); back(); }
  else if (k === ' ' && !(e.target.closest && e.target.closest('button,a'))) { e.preventDefault(); togglePlay(); }
  else if ((k === 'l' || k === 'L') && SL[cur]) { toggleLike(SL[cur]); if (isLiked(SL[cur].item.tr.id)) burst(SL[cur]); }
  else if (k === 'a' || k === 'A') setAuto(!S.auto);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && cur >= 0) { feed.scrollTo({ top: cur * feed.clientHeight, behavior: 'instant' }); sizeViz(); }
});

/* ================= auto mode ================= */
function setAuto(on) {
  S.auto = !!on; save();
  $('#auto').setAttribute('aria-checked', S.auto);
  toast(S.auto ? 'Auto is on. Songs play one after another, even with the screen off.' : 'Auto is off. Each song repeats until you scroll.');
}
$('#auto').onclick = () => setAuto(!S.auto);
$('#auto').setAttribute('aria-checked', S.auto);

/* ================= import: parsing ================= */
const cleanArtist = s => String(s || '').replace(/\s+(feat\.?|ft\.?|featuring|with)\s+.*$/i, '').replace(/\s+/g, ' ').trim();
const cleanTitle = s => String(s || '').replace(/\.(mp3|flac|m4a|ogg|wav|opus|aac)$/i, '').replace(/^\s*\d{1,3}[\s.\-_)]+(?=\D)/, '')
  .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|live|mono|stereo|radio edit|single version|edit|bonus track)\b.*$/i, '').trim();
function splitArtists(s) { s = String(s || ''); return (s.includes(';') ? s.split(';') : s.split(/,\s*/)).map(cleanArtist).filter(Boolean); }
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
  const ai = h.findIndex(x => /^(artist ?name\(s\)|artist ?names?|artists?|artist\(s\)|creator|performer|band|interpret)$/.test(x));
  const ti = h.findIndex(x => /^(track ?name|track ?title|track|title|song|song ?name|name|titel)$/.test(x));
  if (ai < 0) return null;
  return rows.slice(1).map(r => trackRow(ti >= 0 ? r[ti] : '', r[ai])).filter(Boolean);
}
const DUR = /^\d{1,2}:\d{2}(:\d{2})?$/;
function parseLine(l) {
  if (/\t/.test(l)) { // Apple Music / iTunes copy: Name, Time, Artist, Album, ...
    const f = l.split('\t').map(x => x.trim()).filter(x => x && !DUR.test(x) && !/^\d+$/.test(x));
    if (f.length >= 2) return trackRow(f[0], f[1]);
  }
  l = l.replace(/^\s*(\d{1,4}[.)]\s+|[-*•]\s+)/, '').trim(); if (!l || l.startsWith('#') || /^https?:\/\//.test(l)) return null;
  let m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(l); if (m) return trackRow(m[2], m[1]);
  m = /^(.+?)\s+by\s+(.+)$/i.exec(l); if (m) return trackRow(m[1], m[2]);
  return l.length < 80 ? trackRow('', l) : null; // a bare line is an artist name
}
function parseM3U(txt) {
  const out = []; let pending = null;
  for (const raw of txt.split(/\r?\n/)) {
    const l = raw.trim(); if (!l) continue;
    if (l.startsWith('#EXTINF')) { pending = parseLine(l.replace(/^#EXTINF:[^,]*,/, '')); continue; }
    if (l.startsWith('#')) continue;
    if (pending) { out.push(pending); pending = null; continue; }
    let base = l.split(/[\\/]/).pop(); try { base = decodeURIComponent(base); } catch { }
    const r = parseLine(base.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_/g, ' ')); if (r && r[0]) out.push(r);
  }
  return out;
}
function parseXSPF(txt) {
  const doc = new DOMParser().parseFromString(txt, 'application/xml');
  return [...doc.getElementsByTagName('track')].map(t => trackRow(t.getElementsByTagName('title')[0]?.textContent, t.getElementsByTagName('creator')[0]?.textContent)).filter(Boolean);
}
function parseJSON(txt) { return parseJSONObj(JSON.parse(txt)); }
function parseJSONObj(root) {
  const out = [], seen = new WeakSet();
  const walk = o => {
    if (!o || typeof o !== 'object' || seen.has(o) || out.length > 20000) return; seen.add(o);
    if (!Array.isArray(o)) {
      const ak = Object.keys(o).find(k => /^(artistname|artist|artist_name|creator|artists|byartist|master_metadata_album_artist_name)$/i.test(k));
      const tk = Object.keys(o).find(k => /^(trackname|track_name|title|track|name|song|master_metadata_track_name)$/i.test(k));
      let av = ak && o[ak]; if (Array.isArray(av)) av = av.map(x => typeof x === 'string' ? x : x?.name).filter(Boolean).join(';'); else if (av && typeof av === 'object') av = av.name;
      if (typeof av === 'string' && av && (!tk || typeof o[tk] === 'string')) { const r = trackRow(tk ? o[tk] : '', av); if (r) { out.push(r); return; } }
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(root);
  return out;
}
function parseAny(txt, name = '') {
  txt = txt.replace(/^﻿/, '');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'xspf' || /^\s*(<\?xml|<playlist)/.test(txt)) return parseXSPF(txt);
  if (['json', 'jspf'].includes(ext) || /^\s*[[{]/.test(txt)) { try { return parseJSON(txt); } catch { } }
  if (['m3u', 'm3u8'].includes(ext) || /^#EXTM3U/.test(txt)) return parseM3U(txt);
  if (['csv', 'tsv'].includes(ext) || /^[^\n]*(artist|creator|interpret)[^\n]*[,;\t]/i.test(txt)) { const r = parseCSV(txt); if (r && r.length) return r; }
  return txt.split(/\r?\n/).map(parseLine).filter(Boolean);
}
async function importDeezer(url) {
  const m = /deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(playlist|album)\/(\d+)/i.exec(url);
  if (!m) throw new Error('link');
  const kind = m[1].toLowerCase(), id = m[2];
  const info = await dz(`${kind}/${id}`);
  const rows = []; let index = 0;
  while (index < 3000) {
    const page = await dz(`${kind}/${id}/tracks`, { index, limit: 100 });
    for (const t of page.data || []) if (t.artist?.name) rows.push([t.title_short || t.title, t.artist.name]);
    if (!page.next || !(page.data || []).length) break; index += 100;
  }
  return { name: info.title || 'Deezer ' + kind, rows };
}
/* ---- playlist links from any site ----
   Streaming sites don't let other websites read their pages, so pages are fetched through
   r.jina.ai (a free page reader that allows it), with api.microlink.io as a backup. */
async function fetchPage(url, fmt) {
  const withTimeout = async (p, ms) => { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms); try { return await p(ctl.signal); } finally { clearTimeout(t); } };
  try {
    return await withTimeout(async signal => {
      const r = await fetch('https://r.jina.ai/' + url, { signal, headers: fmt === 'html' ? { 'X-Return-Format': 'html' } : {} });
      if (!r.ok) throw new Error('reader ' + r.status);
      const t = await r.text(); if (t.length < 200) throw new Error('empty'); return t;
    }, 60000);
  } catch {
    return withTimeout(async signal => {
      const r = await fetch('https://api.microlink.io/?' + new URLSearchParams({ url, 'data.html.selector': 'html', 'data.html.attr': 'html', meta: 'false' }), { signal });
      const j = await r.json(); if (j.status !== 'success' || !j.data || !j.data.html) throw new Error('fetch');
      return fmt === 'html' ? j.data.html : textLines(new DOMParser().parseFromString(j.data.html, 'text/html')).join('\n');
    }, 60000);
  }
}
function scriptJSON(html, re) { const m = re.exec(html); if (!m) return null; try { return JSON.parse(m[1]); } catch { try { return JSON.parse(new DOMParser().parseFromString(m[1], 'text/html').documentElement.textContent); } catch { return null; } } }
function textLines(doc) {
  doc.querySelectorAll('script,style,noscript,svg,head').forEach(e => e.remove());
  const out = [], w = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) { const t = n.nodeValue.replace(/\s+/g, ' ').trim(); if (t) out.push(t); }
  return out;
}
function find(o, pred, seen = new WeakSet()) { // depth-first search through parsed JSON
  if (!o || typeof o !== 'object' || seen.has(o)) return null; seen.add(o);
  if (pred(o)) return o;
  for (const v of Object.values(o)) { const r = find(v, pred, seen); if (r) return r; }
  return null;
}
const cleanVideoTitle = t => t.replace(/\s*[([][^)\]]*\b(official|lyrics?|audio|video|visuali[sz]er|hd|4k|hq|remaster(ed)?|music video|mv)\b[^)\]]*[)\]]/gi, '').replace(/\s*\|.*$/, '').trim();
function domPairs(doc) { // rows with an element tagged "artist" next to one tagged "title"
  const tag = el => [el.getAttribute('data-test'), el.getAttribute('data-testid'), typeof el.className === 'string' ? el.className : '', el.getAttribute('itemprop'), el.id].filter(Boolean).join(' ').toLowerCase();
  const short = el => { const t = el.textContent.replace(/\s+/g, ' ').trim(); return t && t.length < 120 ? t : ''; };
  const all = [...(doc.body || doc.documentElement).querySelectorAll('*')];
  const arts = all.filter(el => /artist|byline|performer/.test(tag(el)) && !/album|image|img|avatar|cover/.test(tag(el)) && short(el) && ![...el.children].some(ch => /artist/.test(tag(ch))));
  if (arts.length < 3) return [];
  const rows = [];
  for (const a of arts) {
    let p = a.parentElement;
    for (let d = 0; p && d < 6; d++, p = p.parentElement) {
      const isTitle = el => el !== a && !el.contains(a) && !a.contains(el) && /title|track-?name|song|name/.test(tag(el)) && !/artist|album|playlist|header/.test(tag(el)) && short(el);
      const t = [...p.querySelectorAll('*')].find(el => isTitle(el) && ![...el.querySelectorAll('*')].some(isTitle) && !arts.some(x => el.contains(x)));
      if (t) { const r = trackRow(short(t), short(a)); if (r) rows.push([r, tag(a) + '|' + tag(t)]); break; }
    }
  }
  // real track rows share one layout; keep only the most common artist/title pairing
  const sig = new Map(); for (const [, k] of rows) sig.set(k, (sig.get(k) || 0) + 1);
  const best = [...sig.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 3) return [];
  const kept = rows.filter(r => r[1] === best[0]).map(r => r[0]);
  const site = norm(((doc.querySelector('meta[property="og:site_name"]') || {}).content) || '');
  const head = /^(title|titles|artist|artists|album|time|duration|date added|collection|profiles?|songs?|tracks?|#)$/i;
  return kept.filter(r => !head.test(r[0].trim()) && !head.test(r[1].trim()) && (!site || norm(r[1]) !== site));
}
async function importLink(raw, onStatus) {
  let url = raw.trim().replace(/^<|>$/g, '');
  const sm = /spotify:(playlist|album|track|artist):([A-Za-z0-9]{22})/.exec(url);
  if (sm) url = `https://open.spotify.com/${sm[1]}/${sm[2]}`;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let u; try { u = new URL(url); } catch { throw new Error('notlink'); }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (/\s/.test(raw.trim()) || !host.includes('.')) throw new Error('notlink');
  onStatus('Reading the playlist');
  // short share links: follow them first
  if (/^(deezer\.page\.link|link\.deezer\.com|spotify\.link|spotify\.app\.link|youtu\.be|on\.soundcloud\.com|tidal\.link|amzn\.to)$/.test(host) && !/^youtu\.be$/.test(host)) {
    const md = await fetchPage(url, 'markdown');
    const fin = (/^Final URL:\s*(\S+)/m.exec(md) || [])[1] || (/(https:\/\/(?:www\.)?(?:deezer\.com|open\.spotify\.com|soundcloud\.com|tidal\.com|music\.amazon)[^\s)"']+)/.exec(md) || [])[1];
    if (fin && fin !== url) return importLink(fin, onStatus);
  }
  // Deezer: its own API
  let m = /deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(playlist|album|artist)\/(\d+)/i.exec(url);
  if (m) {
    if (m[1] === 'artist') { const a = await dz(`artist/${m[2]}`); return { name: a.name, rows: [['', a.name]] }; }
    return importDeezer(url);
  }
  // Spotify: the public embed page lists up to 100 songs
  m = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track|artist)\/([A-Za-z0-9]{22})/.exec(url);
  if (m) {
    const html = await fetchPage(`https://open.spotify.com/embed/${m[1]}/${m[2]}`, 'html');
    const nd = scriptJSON(html, /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const ent = nd && find(nd, o => Array.isArray(o.trackList) || (o.type && o.uri && o.name));
    const list = (nd && find(nd, o => Array.isArray(o.trackList)) || {}).trackList || [];
    const rows = list.map(t => trackRow(t.title, t.subtitle)).filter(Boolean);
    if (!rows.length && ent && m[1] === 'artist') rows.push(['', ent.name]);
    if (rows.length) return { name: (ent && (ent.name || ent.title)) || 'Spotify playlist', rows };
  }
  // YouTube and YouTube Music playlists
  const list = u.searchParams.get('list');
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host) && list) {
    const md = await fetchPage(`https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`, 'markdown');
    const lines = md.split('\n'), rows = [];
    for (let i = 0; i < lines.length; i++) {
      const t = /^#{2,4}\s*\[(.+?)\]\(https:\/\/www\.youtube\.com\/watch\?v=[^)]*\)/.exec(lines[i]); if (!t) continue;
      let ch = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) { const c = /^\[([^\]]+)\]\(https:\/\/www\.youtube\.com\/(?:channel\/|@|c\/|user\/)/.exec(lines[j]); if (c) { ch = c[1]; break; } }
      const title = cleanVideoTitle(t[1]);
      const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
      const r = dash ? trackRow(dash[2], dash[1]) : trackRow(title, ch.replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').replace(/\s*official$/i, '').trim());
      if (r) rows.push(r);
    }
    if (rows.length) return { name: ((/^Title:\s*(.+)$/m.exec(md) || [])[1] || 'YouTube playlist').replace(/\s*-\s*YouTube$/, ''), rows };
    throw new Error('youtube');
  }
  // SoundCloud sets: each row is "N · [uploader](…) · [title](…)"; titles are often "Artist - Song"
  if (/(^|\.)soundcloud\.com$/.test(host) && /\/sets\//.test(u.pathname)) {
    const md = await fetchPage(url, 'markdown'), rows = [];
    for (const l of md.split('\n')) {
      const m2 = /^\*\s+\[\]\([^)]*\)\s+\d+\s+·\s+\[([^\]]+)\]\([^)]*\)\s+·\s+\[([^\]]+)\]/.exec(l); if (!m2) continue;
      const title = cleanVideoTitle(m2[2]), dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
      const r = dash ? trackRow(dash[2], dash[1]) : trackRow(title, m2[1]); if (r) rows.push(r);
    }
    if (rows.length) return { name: (/^Title:\s*(.+)$/m.exec(md) || [])[1] || 'SoundCloud playlist', rows };
  }
  // everything else: structured data in the page, then row layout, then plain text checked against Deezer
  const html = await fetchPage(url, 'html');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const name = (doc.querySelector('meta[property="og:title"]')?.content || doc.title || 'Imported playlist').replace(/\s*[|·–-]\s*(Apple Music|TIDAL|SoundCloud|Amazon Music|Last\.fm|Bandcamp|Qobuz).*$/i, '').trim();
  let rows = [];
  const ad = scriptJSON(html, /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/); // Apple Music
  if (ad) rows = parseJSONObj(ad).filter(r => r[0]);
  if (rows.length < 3) for (const sc of doc.querySelectorAll('script[type="application/ld+json"],script[type="application/json"],script#__NEXT_DATA__')) {
    try { rows.push(...parseJSONObj(JSON.parse(sc.textContent)).filter(r => r[0])); } catch { }
  }
  if (rows.length < 3) { const host1 = host.split('.')[0]; rows = domPairs(doc).filter(r => norm(r[1]) !== host1); }
  if (rows.length < 3) {
    const lines = pageLines(textLines(doc).join('\n')).slice(0, 160);
    const found = await matchLines(lines, (i, n, f) => onStatus(`Matching songs: ${plural(f, 'song')} found`, n ? i / n : 1));
    rows = found.map(t => [t.t, t.a]);
  }
  const seen = new Set(); rows = rows.filter(r => { const k = norm(r[0]) + '|' + norm(r[1]); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!rows.length) throw new Error('nothing');
  return { name, rows };
}
function addCrate(name, rows, src) {
  rows = rows.filter(r => r && r[1]);
  if (!rows.length) { toast('No songs or artists found in that. Check the format and try again.'); return false; }
  S.crates.unshift({ id: uid(), name: String(name).slice(0, 80) || 'Imported playlist', src, ts: Date.now(), tracks: rows.slice(0, 5000) });
  save(true); tasteChanged();
  const ar = new Set(rows.map(r => norm(r[1]))).size;
  const songs = rows.filter(r => r[0]).length;
  toast(songs ? `Added ${plural(songs, 'song')} from ${plural(ar, 'artist')}. Your feed now digs from them.` : `Added ${plural(ar, 'artist')}. Your feed now digs from them.`);
  return true;
}
function tasteChanged() {
  resetGraph(); flushReady(); emptyFills = 0;
  // songs queued from the old taste give way to the new one (the next song stays if already playing along)
  const keepTo = started ? cur + 1 : -1;
  for (let i = SL.length - 1; i > keepTo; i--) {
    const s = SL[i]; io.unobserve(s.el); s.el.remove(); unrealize(s.item); SL.splice(i, 1); delete S.seen[s.item.tr.id];
    if (cur > i) cur--;
  }
  if (!started) { cur = SL.length; placeViz(null); feed.scrollTo({ top: 0, behavior: 'instant' }); }
  G.shownA = new Set(SL.map(s => s.item.artist && s.item.artist.id).filter(Boolean));
  ensureAhead(); renderStart();
}

/* page text matched against Deezer: last resort for sites without structured data */
const LINE_NOISE = /^(shuffle|play|playing|liked songs|add to playlist|add songs|download(ed)?|search|home|library|your library|premium|sort|filter|edit|share|songs?|albums?|artists?|playlists?|recommended|explore|following|follow|more|now playing|up next|queue|lyrics|related|for you|radio|browse|listen now|e)$/i;
function cleanLine(l) {
  return l.replace(/[|¦©®™“”"«»]/g, ' ').replace(/^[^\p{L}\p{N}(]+/u, '').replace(/^E\s+(?=\p{L})/u, '').replace(/\s+\d{1,2}:\d{2}\b.*$/, '')
    .replace(/\s+[^\p{L}\p{N})\]!?]+$/u, '').replace(/\s{2,}/g, ' ').trim();
}
function pageLines(text) {
  return text.split('\n').map(cleanLine).filter(l => l.length >= 2 && /\p{L}/u.test(l) && !LINE_NOISE.test(l) && !/^\d+ (songs?|titles?|tracks?)/i.test(l) && (l.match(/\p{L}/gu) || []).length / l.length > .45);
}
async function matchLines(lines, onStep) {
  const out = [], seen = new Set();
  const accept = (r, t, a) => r && titleSim(t, r.t) >= .62 && (dice(norm(a), norm(r.a)) >= .55 || (norm(r.a).length > 2 && norm(a).includes(norm(r.a))));
  const push = r => { if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } };
  for (let i = 0; i < lines.length; i++) {
    onStep(i, lines.length, out.length);
    const T = lines[i], A = (lines[i + 1] || '').split(/\s*[•·∙|]\s*|\s+-\s+|,\s*/)[0];
    try {
      if (A) {
        let r = (await api.searchTrack(`artist:"${A}" track:"${T}"`, 3)).find(x => accept(x, T, A));
        if (!r) r = (await api.searchTrack(`${T} ${A}`, 5)).find(x => accept(x, T, A));
        if (r) { push(r); i++; continue; }
      }
      const parts = T.split(/\s+[-–—•·]\s+/);
      if (parts.length === 2) {
        const r = (await api.searchTrack(`${parts[0]} ${parts[1]}`, 5)).find(x => accept(x, parts[1], parts[0]) || accept(x, parts[0], parts[1]));
        if (r) push(r);
      }
    } catch { }
  }
  onStep(lines.length, lines.length, out.length);
  return out;
}

/* ================= link box (start screen and Library) ================= */
const LINK_HELP = 'Works with Spotify, Apple Music, YouTube, YouTube Music, Deezer, Tidal, SoundCloud and most other sites. The playlist must be public.';
function wireLink(input, btn, out, done) {
  let busy = false;
  const go = async () => {
    const v = input.value.trim(); if (!v || busy) return;
    busy = true; btn.disabled = true; input.disabled = true;
    const set = (msg, frac) => { out.innerHTML = `<div class="progress">${esc(msg)}<div class="bar"><i style="width:${Math.round((frac ?? .3) * 100)}%"></i></div></div>`; };
    try {
      const { name, rows } = await importLink(v, set);
      out.innerHTML = '';
      if (addCrate(name, rows, 'link')) { input.value = ''; done && done(); }
    } catch (e) {
      const msg = e.message === 'notlink' ? 'That doesn’t look like a link. Copy the playlist’s share link and paste it here.'
        : e.message === 'youtube' ? 'That YouTube playlist couldn’t be read. Auto-generated mixes and private playlists can’t be opened; try a regular public playlist.'
        : e.message === 'nothing' ? 'No songs found on that page. Make sure the playlist is public, or try the Files and other ways options.'
        : 'That link couldn’t be opened right now. Check your connection and try again in a minute.';
      out.innerHTML = `<div class="guide">${msg}</div>`;
    } finally { busy = false; btn.disabled = false; input.disabled = false; }
  };
  btn.onclick = go; input.onkeydown = e => { if (e.key === 'Enter') go(); };
}

/* ================= start screen ================= */
const startEl = $('#start');
function renderStart() {
  if (started) { startEl.hidden = true; return; }
  startEl.hidden = false;
  if (hasTaste()) {
    const own = [...tasteMap().values()].sort((a, b) => b.w - a.w), names = own.slice(0, 3).map(s => s.name);
    startEl.classList.add('over');
    startEl.innerHTML = `<div class="sbox">
      <h1>New music, one song at a time.</h1>
      <p>Picked from artists near ${esc(names.join(', '))}${own.length > 3 ? ' and the rest of your music' : ''}. Scroll for the next song and like the ones you love.</p>
      <div class="go row"><button class="bigplay" id="go">${I.play}Start listening</button><button class="pill" id="golib">Library</button></div></div>`;
    $('#go').onclick = start;
    $('#golib').onclick = () => openSheet();
  } else {
    startEl.classList.remove('over');
    startEl.innerHTML = `<div class="sbox">
      <h1>Endless new music, one song at a time.</h1>
      <p>Scroll for the next song, like the ones you love. Sidetrack learns from every like and skip.</p>
      <div class="go"><button class="bigplay" id="go">${I.play}Start listening</button></div>
      <p class="sub">Starts with what’s popular right now. Add a playlist to start from your own taste instead:</p>
      <div class="row nw linkrow"><input type="url" id="oblink" placeholder="Paste a playlist link" aria-label="Playlist link"><button class="pill solid" id="oblinkgo">Add</button></div>
      <div id="oblinkout"></div>
      <p class="fine">${LINK_HELP}</p>
      <div class="row more"><button class="textbtn" data-open="more">Files and other ways</button><button class="textbtn" id="obartists">Name some artists</button></div>
      <div id="obpick" hidden>
        <div class="sugg"><input type="search" id="obq" placeholder="Start typing an artist" autocomplete="off" aria-label="Search for an artist"><ul id="obs" hidden></ul></div>
        <div class="chips" id="obchips"></div>
        <button class="pill solid" id="obgo" hidden>Add artists</button>
      </div>
    </div>`;
    $('#go').onclick = start;
    wireLink($('#oblink'), $('#oblinkgo'), $('#oblinkout'));
    $$('[data-open]', startEl).forEach(b => b.onclick = () => openSheet(b.dataset.open));
    $('#obartists').onclick = () => { $('#obpick').hidden = false; $('#obq').focus(); };
    wireArtistPicker($('#obq'), $('#obs'), $('#obchips'), picked => {
      const go = $('#obgo'); go.hidden = !picked.size; go.textContent = `Add ${plural(picked.size, 'artist')}`;
      go.onclick = () => addCrate('Artists I picked', [...picked.values()].map(a => ['', a.name]), 'picked');
    });
  }
}
function wireArtistPicker(q, list, chips, onChange) {
  const picked = new Map(); let found = [];
  const draw = () => { chips.innerHTML = [...picked.values()].map(a => `<span class="chip">${esc(a.name)}<button data-rm="${a.id}" aria-label="Remove ${esc(a.name)}">×</button></span>`).join(''); onChange(picked); };
  q.oninput = debounce(async () => {
    const v = q.value.trim(); if (!v) { list.hidden = true; return; }
    const r = await api.searchArtist(v).catch(() => []);
    if (q.value.trim() !== v) return;
    found = r;
    list.innerHTML = r.map((a, i) => `<li><button type="button" data-i="${i}">${a.p ? `<img src="${artUrl(a.p, 56)}" alt="">` : '<img alt="">'}<span>${esc(a.name)} <small class="muted">${fmtN(a.fans)} fans</small></span></button></li>`).join('');
    list.hidden = !r.length;
  }, 250);
  list.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; const a = found[+b.dataset.i]; picked.set(a.id, a); q.value = ''; list.hidden = true; q.focus(); draw(); };
  chips.onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { picked.delete(+b.dataset.rm); draw(); } };
}
function start() {
  if (started) return;
  unlockAudio(); // must happen inside the tap
  started = true; startEl.hidden = true;
  if (cur >= 0 && cur < SL.length) { playSlide(SL[cur]); ensureAhead(); }
  else if (SL.length) { activate(0); snapTo(0, true); }
  else { cur = SL.length; ensureAhead(); }
  setTimeout(learnRefs, 6000);
}

/* ================= library sheet ================= */
const sheet = $('#sheet');
$('#libbtn').onclick = () => openSheet();
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close(); });
sheet.addEventListener('close', renderStart);
function openSheet(focus) {
  renderSheet();
  if (!sheet.open) sheet.showModal();
  if (focus) { const el = $(`[data-sec=${focus}]`, sheet); if (el) { el.scrollIntoView({ block: 'start' }); el.classList.add('main'); } }
}
function renderSheet() {
  const ml = S.ml, refs = ml.pos.filter(e => e.src === 'ref').length, lk = ml.pos.filter(e => e.src === 'like').length;
  $('#sheetBody').innerHTML = `
    <div class="shead"><h2>Library</h2><button class="x" data-x aria-label="Close">${I.x}</button></div>
    <div class="sec">
      <h3>Add music</h3><p>Your playlists steer the feed. Sidetrack never plays you artists you already have. Links are read through the free page reader r.jina.ai.</p>
      <div class="imp">
        <div class="opt" data-sec="file"><b>Playlist link</b>
          <small>${LINK_HELP}</small>
          <div class="row nw"><input type="url" id="link" placeholder="Paste a playlist link" aria-label="Playlist link"><button class="btn primary" id="linkgo">Add</button></div>
          <div id="linkout"></div></div>
        <div class="opt" data-sec="more"><b>Playlist file</b>
          <small>Exportify CSV, Spotify data export (JSON), M3U, XSPF, JSPF or TXT</small>
          <div class="drop" id="drop" tabindex="0" role="button">Drop files here or click to choose</div><input type="file" id="filein" multiple accept=".csv,.tsv,.m3u,.m3u8,.xspf,.jspf,.json,.txt" hidden></div>
        <div class="opt"><b>Paste a list</b>
          <small>One song per line, like “Artist - Song”, or just artist names. In Apple Music or iTunes on a computer, select songs, copy and paste them here.</small>
          <textarea id="paste" rows="4" aria-label="Songs or artists"></textarea>
          <div class="row" style="margin-top:8px"><button class="btn primary" id="pastego">Add list</button></div></div>
        <div class="opt"><b>Name artists</b>
          <div class="sugg" style="margin-top:8px"><input type="search" id="lq" placeholder="Start typing an artist" autocomplete="off" aria-label="Search for an artist"><ul id="ls" hidden></ul></div>
          <div class="chips" id="lchips"></div><button class="btn primary" id="lgo" hidden>Add artists</button></div>
      </div>
    </div>
    <div class="sec"><h3>Your music</h3>
      <div class="list">${S.crates.length ? S.crates.map(c => {
        const cnt = new Map(); for (const [, a] of c.tracks) cnt.set(a, (cnt.get(a) || 0) + 1);
        const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
        return `<div class="it"><span class="stack">${c.tracks.length > 999 ? fmtN(c.tracks.length) : c.tracks.length}</span><div><b>${esc(c.name)}</b><small>${esc(top.join(', '))}</small></div><button class="btn sm" data-delcrate="${esc(c.id)}">Remove</button></div>`;
      }).join('') : '<p class="muted small" style="margin:0">Nothing yet.</p>'}</div>
    </div>
    <div class="sec"><h3>Discovery</h3>
      <div class="dial"><label for="dial">Familiar</label><input type="range" id="dial" min="0" max="1" step=".05" value="${S.dial}"><span>Deep cuts</span></div>
      <p class="stat" style="margin-top:14px">The on-device model has learned the sound of <b>${plural(refs, 'song')}</b> from your playlists, <b>${plural(lk, 'like')}</b> and <b>${plural(ml.neg.length, 'skip')}</b>.</p>
      <p class="muted small" style="margin:0">A song you leave within 7 seconds counts as a skip.${DATA.bytes ? ` Audio downloaded this session: ${(DATA.bytes / 1048576).toFixed(1)} MB.` : ''}${saveData ? ' Data saver is on, so Sidetrack loads fewer songs ahead.' : ''}</p>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="forget">Reset what it learned</button></div>
    </div>
    <div class="sec"><h3>Liked songs</h3>
      ${S.likes.length ? `<div class="row" style="margin-bottom:8px"><button class="btn sm" data-export="csv">Export CSV</button><button class="btn sm" data-export="txt">Export text</button></div>
      <p class="muted small" style="margin:0 0 6px">Import the CSV into Spotify, Apple Music or YouTube Music with a tool like TuneMyMusic.</p>
      <div class="list">${S.likes.map(l => `<div class="it"><img src="${coverUrl(l.c, 56)}" alt="" loading="lazy"><div><b>${esc(l.t)}</b><small>${esc(l.a)}</small></div><div class="ra"><button class="btn sm" data-playlike="${l.id}">Play</button><button class="btn sm" data-unlike="${l.id}" aria-label="Unlike ${esc(l.t)}">Unlike</button></div></div>`).join('')}</div>`
      : '<p class="muted small" style="margin:0">Songs you like show up here.</p>'}
    </div>
    <div class="sec"><h3>Backup</h3><p>Everything is stored in this browser only.</p>
      <div class="row"><button class="btn sm" id="bk">Download backup</button><button class="btn sm" id="rs">Restore backup</button><input type="file" id="rsin" accept=".json" hidden></div></div>`;
  wireSheet();
}
function wireSheet() {
  const b = $('#sheetBody');
  $('[data-x]', b).onclick = () => sheet.close();
  wireLink($('#link'), $('#linkgo'), $('#linkout'), () => renderSheet());
  const drop = $('#drop'), fin = $('#filein');
  const readFiles = async fs => {
    let any = false;
    for (const f of fs) { if (f.size > 40e6) { toast(`${f.name} is too large.`); continue; } any = addCrate(f.name.replace(/\.[^.]+$/, ''), parseAny(await f.text(), f.name), 'file') || any; }
    if (any) renderSheet();
  };
  drop.onclick = () => fin.click(); drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fin.click(); } };
  fin.onchange = () => readFiles([...fin.files]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); readFiles([...e.dataTransfer.files]); };
  $('#pastego').onclick = () => {
    const v = $('#paste').value, rows = parseAny(v);
    if (!rows.length && /open\.spotify\.com\/track\//.test(v)) { toast('Spotify copies song links, not names. Paste the playlist’s link in Playlist link instead.'); return; }
    if (addCrate('Pasted list', rows, 'paste')) renderSheet();
  };
  wireArtistPicker($('#lq'), $('#ls'), $('#lchips'), picked => {
    const go = $('#lgo'); go.hidden = !picked.size; go.textContent = `Add ${plural(picked.size, 'artist')}`;
    go.onclick = () => {
      let c = S.crates.find(c => c.src === 'picked');
      if (!c) { c = { id: uid(), name: 'Artists I picked', src: 'picked', ts: Date.now(), tracks: [] }; S.crates.unshift(c); }
      for (const a of picked.values()) if (!c.tracks.some(r => norm(r[1]) === norm(a.name))) c.tracks.push(['', a.name]);
      save(true); tasteChanged(); toast(`Added ${plural(picked.size, 'artist')}.`); renderSheet();
    };
  });
  $$('[data-delcrate]', b).forEach(x => x.onclick = () => {
    const c = S.crates.find(c => c.id === x.dataset.delcrate); if (!c || !confirm(`Remove “${c.name}”? Its artists stop shaping your feed.`)) return;
    S.crates = S.crates.filter(y => y !== c); S.ml.pos = S.ml.pos.filter(e => !(e.src === 'ref' && e.crate === c.id)); lrDirty = true;
    save(true); tasteChanged(); renderSheet();
  });
  $('#dial').onchange = e => { S.dial = +e.target.value; save(); tasteChanged(); };
  $('#forget').onclick = () => {
    if (!confirm('Forget every like, skip and playlist sound the model learned? Your liked songs list stays.')) return;
    S.ml = { pos: [], neg: [], st: null }; S.skipA = {}; S.crates.forEach(c => c.refTried = 0); lrDirty = true;
    save(true); renderSheet(); toast('Reset. It relearns your playlists in the background.');
  };
  const dl = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  $$('[data-export]', b).forEach(x => x.onclick = () => x.dataset.export === 'csv'
    ? dl('sidetrack-liked.csv', 'Track name,Artist name,Album\n' + S.likes.map(l => [l.t, l.a, l.al].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv')
    : dl('sidetrack-liked.txt', S.likes.map(l => `${l.a} - ${l.t}`).join('\n'), 'text/plain'));
  $$('[data-unlike]', b).forEach(x => x.onclick = () => { const id = +x.dataset.unlike; S.likes = S.likes.filter(l => l.id !== id); dropExample('pos', id, 'like'); save(); syncLikes(id); renderSheet(); });
  $$('[data-playlike]', b).forEach(x => x.onclick = () => { const l = S.likes.find(l => l.id === +x.dataset.playlike); if (l) playNow(l); });
  $('#bk').onclick = () => dl(`sidetrack-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(S), 'application/json');
  $('#rs').onclick = () => $('#rsin').click();
  $('#rsin').onchange = async e => {
    try {
      const d = JSON.parse(await e.target.files[0].text()); if (!Array.isArray(d.crates) || !Array.isArray(d.likes)) throw 0;
      Object.assign(S, defaults(), d, { ml: { ...defaults().ml, ...(d.ml || {}) } }); lrDirty = true;
      save(true); tasteChanged(); renderSheet(); toast('Backup restored.');
    } catch { toast('That file is not a Sidetrack backup.'); }
  };
}
function playNow(l) {
  sheet.close();
  const item = { tr: { id: l.id, t: l.t, a: l.a, ai: l.ai, al: l.al, c: l.c }, via: null, label: 'From your likes', g: 0 };
  if (!started) { unlockAudio(); started = true; startEl.hidden = true; }
  const at = Math.min(cur + 1, SL.length);
  makeSlide(item, Math.max(0, at));
  activate(Math.max(0, at)); snapTo(Math.max(0, at));
}

/* ================= boot ================= */
renderStart();
updateLoader();
fill();
