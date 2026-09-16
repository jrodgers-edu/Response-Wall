/* =====================================================================
   RESPONSE WALL STUDIO — shared layer.

   Loaded by every page in app/. Owns:
     · Firebase (Realtime Database + Google sign-in)
     · the deck model: parsing an rsn-interactive-deck .html into slides,
       styles, notes and orbit modules; building question slides that
       borrow the deck's own classes so they match by construction
     · the wall CSS painted over question slides
     · small helpers (ids, escaping, QR, CSV)

   Data lives under /studio in the response-wall database:
     studio/decks/<id>        deck card for the library (title, counts)
     studio/deckdocs/<id>     the full deck document
     studio/live              the one live session pointer, public read
     studio/sessions/<sid>    meta (owner), shown + votes (public read)
     studio/pending/<sid>     unmoderated text, created by participants,
                              readable and deletable only by the owner
   ===================================================================== */
(function(global){
  "use strict";

  const CONFIG = {
    apiKey: "AIzaSyCYzKZ72OxWMVcA1fOhVYLEso7ZbEIUo_8",
    authDomain: "response-wall.firebaseapp.com",
    databaseURL: "https://response-wall-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "response-wall",
    appId: "1:533565075857:web:5dd4a957e5245bd2aa6a30"
  };

  const JOIN_URL = 'https://jrodgers-edu.github.io/Response-Wall/app/';
  const JOIN_SHORT = 'jrodgers-edu.github.io/Response-Wall/app';

  const P = {
    decks:    'studio/decks',
    deckdocs: 'studio/deckdocs',
    live:     'studio/live',
    sessions: 'studio/sessions',
    pending:  'studio/pending'
  };

  const BRAND = ['#E94E1D','#1D6FB8','#2EA5DE','#FAB60B','#BD1823'];

  /* ---------- tiny helpers ---------- */
  const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const attr = esc;
  const clock = ts => new Date(ts).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
  const dateStamp = ts => new Date(ts).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
  const stripTags = h => { const d = document.createElement('div'); d.innerHTML = h; return (d.textContent || '').replace(/\s+/g, ' ').trim(); };

  function clientId(){
    let id = null;
    try{ id = localStorage.getItem('rw:client'); }catch(e){}
    if(!id){
      id = 'c' + uid().replace(/[^A-Za-z0-9_-]/g, '');
      try{ localStorage.setItem('rw:client', id); }catch(e){}
    }
    return id;
  }

  /* ---------- Firebase ---------- */
  let app = null, db = null, auth = null;
  function init(){
    if(app) return { app, db, auth };
    app  = firebase.initializeApp(CONFIG);
    db   = firebase.database();
    /* The participant page is anonymous and loads only the app + database
       SDKs, so firebase.auth does not exist there. Only wire auth up on the
       pages that load it (studio, present, remote). */
    if(typeof firebase.auth === 'function'){
      auth = firebase.auth();
      try{ auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); }catch(e){}
    }
    return { app, db, auth };
  }
  const ref = path => init().db.ref(path);

  async function signIn(){
    init();
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try{
      return await auth.signInWithPopup(provider);
    }catch(e){
      if(e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')){
        return auth.signInWithRedirect(provider);
      }
      throw e;
    }
  }
  const signOut = () => init().auth.signOut();
  const onAuth = cb => init().auth.onAuthStateChanged(cb);

  /* Wraps a page that only the owner may use: paints a sign-in gate until a
     user is present, then hands over. The database rules do the real gating;
     this just keeps the UI honest. */
  function requireUser(mountEl, onReady){
    init();
    let started = false;
    onAuth(user => {
      if(user){
        if(started) return;
        started = true;
        mountEl.innerHTML = '';
        onReady(user);
      } else {
        started = false;
        mountEl.innerHTML =
          '<div class="gate"><div class="gate-card">' +
          '<div class="gate-mark">Response Wall Studio</div>' +
          '<h1>Sign in to continue</h1>' +
          '<p>Decks, sessions and the moderation queue are yours alone. Participants never see this screen.</p>' +
          '<button class="btn primary" id="gate-signin">Sign in with Google</button>' +
          '<p class="gate-err" id="gate-err" hidden></p>' +
          '</div></div>';
        mountEl.querySelector('#gate-signin').onclick = async () => {
          const err = mountEl.querySelector('#gate-err');
          err.hidden = true;
          try{ await signIn(); }
          catch(e){ err.hidden = false; err.textContent = (e && e.message) || 'Sign-in failed'; }
        };
      }
    });
  }

  /* ---------- realtime helpers ---------- */
  function watch(path, cb){
    const r = ref(path);
    const h = r.on('value', snap => cb(snap.val()), err => { console.warn('watch', path, err); cb(undefined, err); });
    return () => r.off('value', h);
  }
  const get = async path => (await ref(path).once('value')).val();
  const set = (path, val) => ref(path).set(val);
  const update = (path, val) => ref(path).update(val);
  const remove = path => ref(path).remove();
  const push = (path, val) => ref(path).push(val);

  /* =====================================================================
     DECK MODEL
     A deck document:
       { title, footer, styles:[{id, css}], modules:[...], notes:{key:[p]},
         slides:[ {id, kind:'html', key, html, hidden}
                | {id, kind:'q', key, type, kicker, question, hint,
                   options:[], multi, min, max, minLabel, maxLabel, anchor, hidden} ],
         createdAt, updatedAt }
     ===================================================================== */

  const Q_TYPES = {
    text:   { label: 'Open text wall',   moderated: true  },
    words:  { label: 'Word cloud',       moderated: true  },
    choice: { label: 'Multiple choice',  moderated: false },
    scale:  { label: 'Scale',            moderated: false },
    join:   { label: 'Join slide',       moderated: false }
  };

  /* Pull `const NAME=<literal>;` out of script text by brace matching, then
     evaluate the literal. The deck is John's own file, so evaluating its
     data blocks is acceptable; nothing else in the script is run. */
  function extractLiteral(src, name){
    const m = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*').exec(src);
    if(!m) return null;
    let i = m.index + m[0].length;
    const open = src[i];
    const close = open === '[' ? ']' : open === '{' ? '}' : null;
    if(!close) return null;
    let depth = 0, inStr = null, escd = false;
    for(let j = i; j < src.length; j++){
      const ch = src[j];
      if(inStr){
        if(escd){ escd = false; continue; }
        if(ch === '\\'){ escd = true; continue; }
        if(ch === inStr) inStr = null;
        continue;
      }
      if(ch === '"' || ch === "'" || ch === '`'){ inStr = ch; continue; }
      if(ch === open) depth++;
      else if(ch === close){ depth--; if(depth === 0) return src.slice(i, j + 1); }
    }
    return null;
  }
  function evalLiteral(lit){
    if(!lit) return null;
    try{ return (new Function('return (' + lit + ');'))(); }catch(e){ console.warn('literal', e); return null; }
  }

  function parseDeckFile(html){
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const problems = [];

    const titleEl = doc.querySelector('title');
    const title = (titleEl ? titleEl.textContent : '').replace(/\s*[—–-]\s*Cornwall Research School\s*$/i, '').trim() || 'Untitled deck';

    /* styles: everything in <head>, minus a wall layer from an earlier weave */
    const styles = [...doc.querySelectorAll('head style')].map((s, i) => ({
      id: s.id || (i === 0 ? 'base' : 'style' + i),
      css: s.textContent
    })).filter(s => s.id !== 'wall');
    if(!styles.length) problems.push('No <style> block found in the head. Is this an rsn-interactive-deck file?');

    const footEl = doc.querySelector('.slide-foot');
    const footer = footEl ? footEl.textContent.trim() : 'Cornwall Research School · Supported by the EEF';

    /* data blocks from the engine script */
    const scriptText = [...doc.querySelectorAll('script')].map(s => s.textContent).join('\n');
    const modules = evalLiteral(extractLiteral(scriptText, 'MODULES')) || [];
    const notes = evalLiteral(extractLiteral(scriptText, 'NOTES')) || {};
    /* a woven deck appends NOTES["w-q1"]=[...] after the block */
    const extra = /NOTES\[\s*(["'])(.+?)\1\s*\]\s*=\s*(\[[\s\S]*?\]);/g;
    let em;
    while((em = extra.exec(scriptText))){
      const v = evalLiteral(em[3]);
      if(v) notes[em[2]] = v;
    }

    const sections = [...doc.querySelectorAll('section.slide')];
    if(!sections.length) problems.push('No <section class="slide"> elements found.');

    const slides = [];
    let lastKey = null;
    sections.forEach((sec, i) => {
      sec.classList.remove('active', 'past');
      const key = sec.dataset.notes || ('s' + (i + 1));
      /* a question slide from an earlier weave comes in as a real question */
      if(sec.classList.contains('wallslide') && sec.dataset.question){
        const qid = (sec.dataset.prompt || uid()).replace(/[^A-Za-z0-9_-]/g, '');
        const kick = sec.querySelector('.kicker');
        const kicker = kick ? kick.textContent.replace(/^\s*Response wall\s*·\s*/i, '').trim() : 'Response wall';
        slides.push({
          id: qid, kind: 'q', key: 'q-' + qid, type: 'text',
          kicker, question: sec.dataset.question, hint: sec.dataset.hint || '',
          anchor: lastKey, hidden: false
        });
        if(notes['w-' + qid] && !notes['q-' + qid]){ notes['q-' + qid] = notes['w-' + qid]; delete notes['w-' + qid]; }
        return;
      }
      slides.push({ id: uid(), kind: 'html', key, html: sec.outerHTML, hidden: false });
      lastKey = key;
    });

    return {
      deck: { title, footer, styles, modules, notes, slides, createdAt: Date.now(), updatedAt: Date.now() },
      problems
    };
  }

  /* When a revised deck file replaces the html slides, keep every question
     slide next to the slide it followed (matched by data-notes key). */
  function mergeRevision(oldDeck, fresh){
    const qs = oldDeck.slides.filter(s => s.kind === 'q');
    const out = [];
    fresh.slides.forEach(s => {
      if(s.kind === 'q'){
        /* the revision carries its own question slides (a re-woven file) — keep ours if ids collide */
        if(!qs.some(q => q.id === s.id)) out.push(s);
        return;
      }
      out.push(s);
      qs.filter(q => q.anchor === s.key).forEach(q => out.push(q));
    });
    /* any question whose anchor vanished goes to the end, in its old order */
    qs.filter(q => !out.includes(q)).forEach(q => out.push(q));
    const notes = Object.assign({}, fresh.notes);
    Object.keys(oldDeck.notes || {}).forEach(k => { if(k.startsWith('q-')) notes[k] = oldDeck.notes[k]; });
    return Object.assign({}, oldDeck, {
      title: fresh.title, footer: fresh.footer, styles: fresh.styles, modules: fresh.modules,
      notes, slides: out, updatedAt: Date.now()
    });
  }

  function slideTitle(s){
    if(s.kind === 'q') return s.type === 'join' ? 'Scan to join' : (s.question || '(untitled question)');
    const d = document.createElement('div'); d.innerHTML = s.html;
    const h = d.querySelector('h1, h2, h3, .kicker');
    return h ? (h.textContent || '').replace(/\s+/g, ' ').trim() : 'Slide';
  }

  function newQuestion(type){
    const base = { id: uid().replace(/[^A-Za-z0-9_-]/g, ''), kind: 'q', type, kicker: 'Response wall',
                   question: '', hint: '', hidden: false };
    base.key = 'q-' + base.id;
    if(type === 'choice'){ base.options = ['', '', '']; base.multi = false; }
    if(type === 'scale'){ base.min = 1; base.max = 5; base.minLabel = 'Not at all'; base.maxLabel = 'Completely'; }
    if(type === 'join'){ base.question = 'Scan to join the response wall'; base.hint = 'Your answers are anonymous. Nothing reaches the screen until it has been shown.'; }
    return base;
  }

  /* The live question object published for phones */
  function liveQuestion(slide){
    if(!slide || slide.kind !== 'q' || slide.type === 'join') return null;
    const q = { id: slide.id, type: slide.type, question: slide.question || '', hint: slide.hint || '',
                moderated: !!Q_TYPES[slide.type].moderated };
    if(slide.type === 'choice'){ q.options = (slide.options || []).filter(o => o && o.trim()); q.multi = !!slide.multi; }
    if(slide.type === 'scale'){ q.min = +slide.min || 1; q.max = +slide.max || 5; q.minLabel = slide.minLabel || ''; q.maxLabel = slide.maxLabel || ''; }
    return q;
  }

  /* =====================================================================
     QUESTION SLIDE MARKUP — uses the deck's own kicker / h2 / reveal / card
     classes, so it inherits the uploaded deck's design by construction.
     ===================================================================== */
  function qrSvg(text, opts){
    if(typeof qrcode === 'undefined') return '';
    try{
      const q = qrcode(0, 'M'); q.addData(text); q.make();
      const n = q.getModuleCount(), quiet = 2, span = n + quiet * 2;
      let d = '';
      for(let r = 0; r < n; r++) for(let c = 0; c < n; c++)
        if(q.isDark(r, c)) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
      const fill = (opts && opts.dark) || '#2b2b2b';
      return '<svg viewBox="0 0 ' + span + ' ' + span + '" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="Scan to join">' +
             '<rect width="' + span + '" height="' + span + '" fill="#fff"/><path d="' + d + '" fill="' + fill + '"/></svg>';
    }catch(e){ return ''; }
  }

  function sideBlock(tallyLabel){
    return '<aside class="wallside">' +
      '<div class="wallqr">' + qrSvg(JOIN_URL) +
        '<div class="qr-hint">Scan to join</div><div class="url">' + esc(JOIN_SHORT) + '</div></div>' +
      '<div class="walltally"><div class="n">0</div><span>' + esc(tallyLabel) + '</span></div>' +
    '</aside>';
  }

  function questionSlideHtml(s){
    const kicker = '<div class="kicker reveal d1"><span class="fx-pulse c-red"></span>&nbsp;' + esc(s.kicker || 'Response wall') + '</div>';
    const hint = s.hint ? '<p class="wallhint reveal d3">' + esc(s.hint) + '</p>' : '';
    const head = '<section class="slide wallslide wall-' + attr(s.type) + '" data-notes="' + attr(s.key) + '" data-qid="' + attr(s.id) + '" data-qtype="' + attr(s.type) + '">';

    if(s.type === 'join'){
      return head +
        '<div class="joinwrap">' +
          '<div>' + kicker +
            '<h2 class="reveal d2">' + esc(s.question || 'Scan to join') + '</h2>' +
            hint +
            '<div class="joinurl reveal d4">' + esc(JOIN_SHORT) + '</div>' +
          '</div>' +
          '<div class="joinqr reveal d3">' + qrSvg(JOIN_URL) + '</div>' +
        '</div></section>';
    }

    let body = '';
    let tally = 'on the wall';
    if(s.type === 'text')   body = '<div class="wallgrid" style="--cols:2"></div>';
    if(s.type === 'words'){ body = '<div class="wallcloud"></div>'; tally = 'words'; }
    if(s.type === 'choice'){
      tally = 'answers';
      body = '<div class="wallbars">' + (s.options || []).filter(o => o && o.trim()).map((o, i) =>
        '<div class="wbar" style="--c:' + BRAND[i % BRAND.length] + '" data-opt="' + i + '">' +
          '<div class="wlab"><span class="wtext">' + esc(o) + '</span><span class="wnum">0</span></div>' +
          '<div class="wtrack"><div class="wfill" style="width:0%"></div></div>' +
        '</div>').join('') + '</div>';
    }
    if(s.type === 'scale'){
      tally = 'answers';
      const min = +s.min || 1, max = +s.max || 5;
      let cols = '';
      for(let v = min; v <= max; v++){
        cols += '<div class="scol" data-v="' + v + '" style="--c:' + BRAND[(v - min) % BRAND.length] + '">' +
                  '<div class="snum">0</div><div class="strack"><div class="sfill" style="height:0%"></div></div><div class="sval">' + v + '</div></div>';
      }
      body = '<div class="wallscale"><div class="scols">' + cols + '</div>' +
             '<div class="slabels"><span>' + esc(s.minLabel || '') + '</span><span class="smean"></span><span>' + esc(s.maxLabel || '') + '</span></div></div>';
    }

    return head + kicker +
      '<h2 class="reveal d2">' + esc(s.question || '') + '</h2>' + hint +
      '<div class="walldeck reveal d4">' + body + sideBlock(tally) + '</div>' +
    '</section>';
  }

  /* ---------- wall CSS: painted over the deck's own styles ---------- */
  const WALL_CSS = `
.slide.wallslide{padding:4.5vh 6vw 6.5vh;justify-content:flex-start}
.wallslide h2{font-size:clamp(20px,2.5vw,35px);margin-bottom:2px;max-width:44ch}
.wallhint{font-size:clamp(12px,1.05vw,15px);color:#9aa6ab;font-style:italic;margin:5px 0 12px}
.walldeck{display:grid;grid-template-columns:1fr clamp(150px,14vw,208px);gap:28px;flex:1;min-height:0;margin-top:4px}
.wallgrid{display:grid;gap:13px;align-content:start;overflow:hidden;min-height:0;grid-template-columns:repeat(var(--cols,2),minmax(0,1fr))}
.wallgrid[data-dense]{gap:9px}
.wallgrid[data-dense] .wc{padding:10px 28px 10px 13px;border-radius:12px}
.wallgrid[data-dense] .wc p{font-size:clamp(11.5px,1vw,14.5px);line-height:1.38}
.wallgrid[data-denser]{gap:7px}
.wallgrid[data-denser] .wc{padding:8px 26px 8px 12px}
.wallgrid[data-denser] .wc p{font-size:clamp(10.5px,.88vw,13px);line-height:1.34}
.wc p{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:var(--lines,8)}
.wallgrid[data-dense] .wc p{--lines:7}
.wallgrid[data-denser] .wc p{--lines:6}
.wc{background:#fff;border:1px solid #eee;border-radius:14px;padding:13px 34px 13px 16px;box-shadow:0 8px 22px rgba(0,0,0,.06);position:relative;overflow:hidden;border-left:5px solid var(--c,#E94E1D);opacity:0;transform:translateY(14px) scale(.97);animation:wcin .45s cubic-bezier(.2,1.3,.4,1) forwards}
@keyframes wcin{to{opacity:1;transform:none}}
.wc p{color:var(--ink);line-height:1.42;overflow-wrap:break-word;font-weight:500}
.wc .n{font-family:'Roboto Slab';font-weight:800;font-size:11px;color:var(--pale);position:absolute;top:11px;right:13px;letter-spacing:.06em}
.wc.size-l p{font-size:clamp(15px,1.5vw,22px)}
.wc.size-m p{font-size:clamp(13.5px,1.22vw,18px)}
.wc.size-s p{font-size:clamp(12px,1.02vw,15px)}
.wallmore{grid-column:1/-1;text-align:center;font-size:13px;color:#9aa6ab;font-style:italic;padding-top:4px}
.wallempty{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;min-height:30vh;color:#b9c2c6;text-align:center;width:100%}
.wallempty strong{font-family:'Roboto Slab';font-weight:700;font-size:clamp(16px,1.7vw,23px);color:#aeb9bd}
.wallempty span{font-size:clamp(12px,1.05vw,15px);font-style:italic}
.wallside{display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:flex-start}
.wallqr{background:#fff;border:1px solid #eee;border-radius:16px;padding:12px;text-align:center;box-shadow:0 8px 22px rgba(0,0,0,.06);width:100%}
.wallqr svg{width:100%;height:auto;border-radius:8px;display:block}
.wallqr .qr-hint{justify-content:center;margin-top:9px;font-size:11px}
.wallqr .url{font-size:9.5px;color:#9aa6ab;word-break:break-all;margin-top:5px;line-height:1.3}
.walltally{text-align:center}
.walltally .n{font-family:'Roboto Slab';font-weight:800;color:var(--orange);font-size:clamp(28px,3.2vw,44px);line-height:1}
.walltally span{display:block;font-size:10px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--grey);margin-top:4px}
/* word cloud */
.wallcloud{display:flex;flex-wrap:wrap;align-content:center;justify-content:center;gap:.35em .9em;min-height:0;overflow:hidden;padding:2vh 1vw;line-height:1.05}
.wallcloud .w{font-family:'Roboto Slab';font-weight:800;color:var(--c,#E94E1D);font-size:calc(clamp(14px,1.3vw,20px) * var(--s,1));opacity:0;transform:scale(.6);animation:wcin .5s cubic-bezier(.2,1.3,.4,1) forwards;white-space:nowrap}
.wallcloud .w small{font-family:'Roboto';font-weight:700;font-size:.45em;color:var(--grey);vertical-align:super;margin-left:3px}
/* choice bars */
.wallbars{display:flex;flex-direction:column;gap:clamp(8px,1.4vh,16px);justify-content:center;min-height:0;padding-right:1vw}
.wbar{opacity:0;animation:wcin .5s ease forwards}
.wlab{display:flex;justify-content:space-between;align-items:baseline;gap:14px;margin-bottom:5px}
.wtext{font-family:'Roboto Slab';font-weight:700;color:var(--ink);font-size:clamp(14px,1.5vw,22px);line-height:1.2}
.wnum{font-family:'Roboto Slab';font-weight:800;color:var(--c);font-size:clamp(14px,1.5vw,22px)}
.wnum small{font-family:'Roboto';font-weight:500;color:var(--grey);font-size:.7em;margin-left:6px}
.wtrack{height:clamp(14px,2.2vh,24px);background:#fff;border:1px solid #eee;border-radius:12px;overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,.05)}
.wfill{height:100%;background:var(--c);border-radius:12px;transition:width .8s cubic-bezier(.2,.8,.2,1);min-width:0}
.wbar.lead .wtext{color:var(--c)}
/* scale */
.wallscale{display:flex;flex-direction:column;justify-content:flex-end;min-height:0;padding:0 1vw}
.scols{display:flex;align-items:flex-end;gap:clamp(10px,1.6vw,26px);height:min(46vh,420px);border-bottom:3px solid var(--pale);padding:0 8px}
.scol{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:6px}
.snum{font-family:'Roboto Slab';font-weight:800;color:var(--c);font-size:clamp(14px,1.6vw,24px)}
.strack{width:100%;flex:1;display:flex;align-items:flex-end}
.sfill{width:100%;background:var(--c);border-radius:10px 10px 0 0;transition:height .8s cubic-bezier(.2,.8,.2,1);min-height:0}
.sval{font-family:'Roboto Slab';font-weight:700;color:var(--ink);font-size:clamp(13px,1.3vw,19px);margin-top:4px}
.slabels{display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:clamp(12px,1.05vw,15px);color:var(--grey);font-style:italic}
.smean{font-style:normal;font-family:'Roboto Slab';font-weight:800;color:var(--orange);font-size:clamp(14px,1.5vw,22px)}
/* join slide */
.joinwrap{display:grid;grid-template-columns:1.1fr .9fr;gap:50px;align-items:center;flex:1}
.joinwrap h2{font-size:clamp(28px,3.9vw,54px)}
.joinurl{display:inline-block;margin-top:26px;font-family:'Roboto Slab';font-weight:700;color:var(--deep-blue);font-size:clamp(15px,1.6vw,22px);border-bottom:3px solid var(--yellow);padding-bottom:4px}
.joinqr{background:#fff;border:1px solid #eee;border-radius:22px;padding:22px;box-shadow:0 14px 40px rgba(0,0,0,.08);max-width:min(52vh,460px);margin:0 auto}
.joinqr svg{width:100%;height:auto;display:block}
.wallstale{position:fixed;top:26px;left:34px;z-index:36;font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#fff;background:var(--red);padding:6px 13px;border-radius:20px;display:none;box-shadow:0 6px 16px rgba(189,24,35,.3)}
.wallstale.show{display:block}
@media (max-width:880px){.walldeck,.joinwrap{grid-template-columns:1fr}.wallside{flex-direction:row}}
`;

  /* =====================================================================
     PAINTING RESULTS ONTO A QUESTION SLIDE
     shown: {itemId: {t, ts}}   votes: {clientId: "value"}
     ===================================================================== */
  const sizeClass = t => t.length <= 40 ? 'size-l' : t.length <= 95 ? 'size-m' : 'size-s';
  const MAX_CARDS = 20;

  function sortedShown(shown){
    return Object.keys(shown || {}).map(k => Object.assign({ id: k }, shown[k])).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  function paintText(el, shown, state){
    const grid = el.querySelector('.wallgrid'), tally = el.querySelector('.walltally .n');
    if(!grid) return;
    const items = sortedShown(shown);
    if(tally) tally.textContent = items.length;
    const cols = items.length <= 2 ? 1 : items.length <= 6 ? 2 : items.length <= 12 ? 3 : 4;
    grid.style.setProperty('--cols', cols);
    grid.toggleAttribute('data-dense', items.length > 8);
    grid.toggleAttribute('data-denser', items.length > 14);
    const seen = state.seen || (state.seen = new Set());
    /* a response taken down must leave the screen too */
    if(items.length < seen.size || [...seen].some(id => !items.find(i => i.id === id))){ grid.innerHTML = ''; seen.clear(); }
    if(!items.length){
      if(!grid.querySelector('.wallempty')) grid.innerHTML = '<div class="wallempty"><strong>Nothing on the wall yet.</strong><span>Scan, type, and it arrives here once it is shown.</span></div>';
      return;
    }
    const empty = grid.querySelector('.wallempty'); if(empty) empty.remove();
    items.forEach((it, i) => {
      if(seen.has(it.id) || i >= MAX_CARDS) return;
      const card = document.createElement('div');
      card.className = 'wc ' + sizeClass(it.t || '');
      card.style.setProperty('--c', BRAND[i % BRAND.length]);
      card.innerHTML = '<span class="n">' + String(i + 1).padStart(2, '0') + '</span><p>' + esc(it.t) + '</p>';
      const more = grid.querySelector('.wallmore');
      if(more) grid.insertBefore(card, more); else grid.appendChild(card);
      seen.add(it.id);
    });
    const overflow = items.length - MAX_CARDS;
    let more = grid.querySelector('.wallmore');
    if(overflow > 0){
      if(!more){ more = document.createElement('div'); more.className = 'wallmore'; grid.appendChild(more); }
      more.textContent = 'and ' + overflow + ' more on the wall';
    } else if(more) more.remove();
  }

  /* each entry is one phrase ("back and forth" stays whole); case and
     punctuation are folded so "Warm." and "warm" count together */
  function wordCounts(shown){
    const counts = new Map(), label = new Map();
    sortedShown(shown).forEach(it => {
      const raw = String(it.t || '').replace(/\s+/g, ' ').trim();
      const key = raw.toLowerCase().replace(/^[^a-z0-9'’]+|[^a-z0-9'’]+$/g, '');
      if(!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
      if(!label.has(key)) label.set(key, raw.replace(/^[^A-Za-z0-9'’]+|[^A-Za-z0-9'’]+$/g, '').toLowerCase());
    });
    return [...counts.entries()].map(([k, n]) => [label.get(k), n]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function paintWords(el, shown){
    const cloud = el.querySelector('.wallcloud'), tally = el.querySelector('.walltally .n');
    if(!cloud) return;
    const words = wordCounts(shown);
    if(tally) tally.textContent = words.reduce((a, w) => a + w[1], 0);
    if(!words.length){
      cloud.innerHTML = '<div class="wallempty"><strong>No words yet.</strong><span>One or two words each. They grow as more people say the same thing.</span></div>';
      return;
    }
    const max = words[0][1];
    const html = words.slice(0, 60).map((w, i) => {
      const s = 1 + 2.6 * (max > 1 ? (w[1] - 1) / (max - 1) : 0);
      return '<span class="w" style="--s:' + s.toFixed(2) + ';--c:' + BRAND[i % BRAND.length] + ';animation-delay:' + Math.min(i * 40, 800) + 'ms">' + esc(w[0]) + (w[1] > 1 ? '<small>' + w[1] + '</small>' : '') + '</span>';
    }).join('');
    if(cloud.dataset.sig !== html.length + ':' + words.length + ':' + max){
      cloud.dataset.sig = html.length + ':' + words.length + ':' + max;
      cloud.innerHTML = html;
    }
  }

  function choiceCounts(votes, nOptions){
    const counts = new Array(nOptions).fill(0);
    let total = 0;
    Object.values(votes || {}).forEach(v => {
      String(v).split(',').forEach(x => { const i = parseInt(x, 10); if(i >= 0 && i < nOptions) counts[i]++; });
      total++;
    });
    return { counts, total };
  }

  function paintChoice(el, votes){
    const bars = [...el.querySelectorAll('.wbar')], tally = el.querySelector('.walltally .n');
    const { counts, total } = choiceCounts(votes, bars.length);
    if(tally) tally.textContent = total;
    const max = Math.max(1, ...counts);
    bars.forEach((b, i) => {
      const pct = total ? Math.round(counts[i] / total * 100) : 0;
      b.querySelector('.wnum').innerHTML = counts[i] + (total ? '<small>' + pct + '%</small>' : '');
      b.querySelector('.wfill').style.width = (counts[i] / max * 100) + '%';
      b.classList.toggle('lead', total > 0 && counts[i] === max);
      b.style.animationDelay = (i * 90) + 'ms';
    });
  }

  function scaleStats(votes, min, max){
    const counts = {}; let total = 0, sum = 0;
    for(let v = min; v <= max; v++) counts[v] = 0;
    Object.values(votes || {}).forEach(v => { const n = parseInt(v, 10); if(n >= min && n <= max){ counts[n]++; total++; sum += n; } });
    return { counts, total, mean: total ? sum / total : null };
  }

  function paintScale(el, votes){
    const cols = [...el.querySelectorAll('.scol')], tally = el.querySelector('.walltally .n');
    if(!cols.length) return;
    const min = +cols[0].dataset.v, max = +cols[cols.length - 1].dataset.v;
    const { counts, total, mean } = scaleStats(votes, min, max);
    if(tally) tally.textContent = total;
    const peak = Math.max(1, ...Object.values(counts));
    cols.forEach(c => {
      const v = +c.dataset.v;
      c.querySelector('.snum').textContent = counts[v];
      c.querySelector('.sfill').style.height = (counts[v] / peak * 100) + '%';
    });
    const m = el.querySelector('.smean');
    if(m) m.textContent = mean == null ? '' : 'average ' + mean.toFixed(1);
  }

  function paintQuestion(el, data, state){
    const type = el.dataset.qtype;
    if(type === 'text')   paintText(el, data && data.shown, state || {});
    if(type === 'words')  paintWords(el, data && data.shown);
    if(type === 'choice') paintChoice(el, data && data.votes);
    if(type === 'scale')  paintScale(el, data && data.votes);
  }

  /* =====================================================================
     EXPORT — one flat CSV row per response, so sessions aggregate
     ===================================================================== */
  function csvCell(v){ v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  function sessionRows(session, deck){
    const rows = [];
    const meta = session.meta || {};
    const qOf = id => (deck && deck.slides || []).find(s => s.kind === 'q' && s.id === id) || (meta.questions || {})[id] || {};
    const base = [session.id, meta.name || '', meta.startedAt ? new Date(meta.startedAt).toISOString().slice(0, 10) : '', meta.deckTitle || ''];
    Object.keys(session.shown || {}).forEach(qid => {
      const q = qOf(qid);
      sortedShown(session.shown[qid]).forEach(it => rows.push(base.concat([qid, q.type || 'text', q.question || '', it.t || '', it.ts ? new Date(it.ts).toISOString() : ''])));
    });
    Object.keys(session.votes || {}).forEach(qid => {
      const q = qOf(qid);
      Object.entries(session.votes[qid]).forEach(([cid, v]) => {
        let val = String(v);
        if(q.type === 'choice' && q.options) val = val.split(',').map(i => q.options[+i] || i).join(' | ');
        rows.push(base.concat([qid, q.type || '', q.question || '', val, '']));
      });
    });
    return rows;
  }

  function toCsv(rows){
    const head = ['session_id', 'session', 'date', 'deck', 'question_id', 'type', 'question', 'response', 'shown_at'];
    return [head].concat(rows).map(r => r.map(csvCell).join(',')).join('\r\n');
  }

  function download(name, text, mime){
    try{
      const blob = new Blob([text], { type: mime || 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      return true;
    }catch(e){ return false; }
  }

  /* ---------- shared UI bits ---------- */
  function toast(msg, ms){
    const old = document.querySelector('.toast'); if(old) old.remove();
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms || 2400);
  }

  const UI_CSS = `
:root{--orange:#E94E1D;--yellow:#FAB60B;--blue:#1D6FB8;--sky:#2EA5DE;--red:#BD1823;--pale:#BCD2DC;--grey:#706F6F;--cream:#EDE8DB;--ink:#2b2b2b;--line:#e6e6e6;--panel:#fff;--bg:#faf9f7}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{background:var(--bg);color:var(--ink);font:400 15px/1.45 'Roboto',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:10px;padding:9px 14px;cursor:pointer;font-weight:600;font-size:14px;transition:border-color .15s,background .15s,color .15s,transform .1s}
.btn:hover{border-color:var(--orange);color:var(--orange)}
.btn:active{transform:translateY(1px)}
.btn.primary{background:var(--orange);border-color:var(--orange);color:#fff}
.btn.primary:hover{background:#d3441a;color:#fff}
.btn.danger:hover{border-color:var(--red);color:var(--red)}
.btn.ghost{border-color:transparent;background:transparent}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.sm{padding:6px 10px;font-size:13px;border-radius:8px}
.mark{font-family:'Roboto Slab',serif;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--orange);font-size:11px}
.gate{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg)}
.gate-card{background:#fff;border:1px solid var(--line);border-radius:22px;padding:40px 36px;max-width:440px;width:100%;box-shadow:0 20px 50px rgba(0,0,0,.07);text-align:center}
.gate-mark{font-family:'Roboto Slab',serif;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--orange);font-size:11px;margin-bottom:14px}
.gate h1{font-family:'Roboto Slab',serif;font-weight:800;font-size:26px;color:var(--ink);margin-bottom:10px}
.gate p{color:var(--grey);margin-bottom:22px;line-height:1.5}
.gate-err{color:var(--red);font-size:13px;margin-top:14px}
.toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;border-radius:12px;padding:11px 18px;font-size:14px;z-index:999;box-shadow:0 10px 30px rgba(0,0,0,.2);animation:toastin .3s ease both;max-width:92vw;text-align:center}
@keyframes toastin{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}
input[type=text],input[type=number],input[type=url],textarea,select{font:inherit;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--orange);box-shadow:0 0 0 3px rgba(233,78,29,.12)}
label.f{display:block;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--grey);margin:14px 0 6px}
.scrim{position:fixed;inset:0;background:rgba(43,43,43,.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100}
.modal{background:#fff;border-radius:20px;width:min(640px,100%);max-height:90vh;overflow:auto;padding:26px 26px 22px;box-shadow:0 30px 80px rgba(0,0,0,.25)}
.modal h2{font-family:'Roboto Slab',serif;font-weight:800;font-size:22px;margin-bottom:4px}
.modal .row{display:flex;gap:10px;justify-content:flex-end;margin-top:22px;flex-wrap:wrap}
.modal .muted{color:var(--grey);font-size:14px}
`;

  function modal(html){
    closeModal();
    const scrim = document.createElement('div'); scrim.className = 'scrim';
    scrim.innerHTML = '<div class="modal" role="dialog">' + html + '</div>';
    scrim.addEventListener('click', e => { if(e.target === scrim) closeModal(); });
    scrim.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
    document.body.appendChild(scrim);
    return scrim.firstElementChild;
  }
  function closeModal(){ document.querySelectorAll('.scrim').forEach(s => s.remove()); }

  global.RW = {
    CONFIG, JOIN_URL, JOIN_SHORT, P, BRAND, Q_TYPES, WALL_CSS, UI_CSS,
    uid, esc, attr, clock, dateStamp, stripTags, clientId,
    init, ref, signIn, signOut, onAuth, requireUser,
    watch, get, set, update, remove, push,
    parseDeckFile, mergeRevision, slideTitle, newQuestion, liveQuestion, questionSlideHtml, qrSvg,
    paintQuestion, wordCounts, choiceCounts, scaleStats, sortedShown,
    sessionRows, toCsv, download, toast, modal, closeModal
  };
})(window);
