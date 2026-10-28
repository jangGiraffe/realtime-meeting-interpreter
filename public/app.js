'use strict';
// ===== 설정 =====
const PRICE_REALTIME_PER_MIN = 0.034;            // gpt-realtime-translate, 오디오 1분당 USD (2026-10-27 기준)
const TEXT_PRICES = {                            // USD / 1M tokens [input, output]
  'gpt-4.1-mini': [0.40, 1.60], 'gpt-4.1': [2.00, 8.00], 'gpt-4.1-nano': [0.10, 0.40],
  'gpt-4o-mini': [0.15, 0.60], 'gpt-5-mini': [0.25, 2.00], 'gpt-5': [1.25, 10.00],
};
const KRW_PER_USD = 1400;
const IDLE_MS = 1300;          // 이 시간 동안 새 글자가 없으면 문장 종료로 보고 확정 처리
const SPLIT_TR_CHARS = 70;     // 쉬지 않고 말할 때 번역문이 이만큼 쌓이면 문장 끝에서 나눔
const SPLIT_FORCE_CHARS = 220; // 원문에 문장 끝이 없어도 번역문이 이만큼 길어지면 나눔
// 번역은 계속 나오는데 원문 인식이 이 시간 동안 없으면 연결을 새로 연다.
// 한국어 발언 중에도 원문이 없으므로 짧게 잡으면 한국어로 길게 말할 때마다 끊는다 (10/28: 20초 → 45초)
const STALL_MS = 45000;
const STALL_OUT_DELTAS = 120;
const STALL_COOLDOWN_MS = 90000;
const NEW_MEETING_GAP_MS = 2 * 3600 * 1000; // 기록 사이 간격이 이보다 크면 다른 회의로 본다
const HISTORY_FOR_CONTEXT = 12;

const $ = id => document.getElementById(id);
const els = {
  feed: $('feed'), history: $('history'), live: $('live'), liveSrc: $('liveSrc'), liveTr: $('liveTr'), empty: $('empty'),
  status: $('status'), elapsed: $('elapsed'), cost: $('cost'), costKrw: $('costKrw'),
  btnStart: $('btnStart'), btnPause: $('btnPause'), btnStop: $('btnStop'), mic: $('micSelect'), meter: $('meterBar'),
  replyInput: $('replyInput'), replyOut: $('replyOut'), btnCopy: $('btnCopy'), toast: $('toast'),
};

// ===== 상태 =====
const S = {
  pc: null, dc: null, stream: null, audioCtx: null, analyser: null,
  state: 'idle',              // idle | connecting | live | paused | reconnecting
  userStopped: true, reconnectTries: 0, reconnectTimer: null,
  seg: newSeg(), items: [], seq: 0,
  late: newLate(),            // 원문 미인식 카드 뒤에 늦게 몰려온 원문

  liveSeconds: 0, textUsd: 0, textModel: 'gpt-4.1-mini',
  lastTick: performance.now(),
};
function newSeg() { return { src: '', tr: '', last: 0 }; }

// ===== 진단 로그 (프로그램 폴더의 debug.log 로 저장) =====
const DBG = { buf: [], counts: {}, raw: 0, dirty: false, peak: 0 };
function dlog(msg) { DBG.buf.push(`[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}`); }
setInterval(async () => {
  if (DBG.dirty) { dlog('이벤트 누적: ' + JSON.stringify(DBG.counts)); DBG.dirty = false; }
  if (!DBG.buf.length) return;
  const lines = DBG.buf.splice(0);
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) }).catch(() => {});
}, 2000);
setInterval(async () => {
  if (S.state !== 'live' || !S.pc) return;
  let sent = 0, recv = 0;
  try { (await S.pc.getStats()).forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'audio') sent = r.bytesSent; if (r.type === 'inbound-rtp' && r.kind === 'audio') recv = r.bytesReceived; }); } catch {}
  dlog(`상태: 마이크 최대레벨 ${DBG.peak.toFixed(0)}%, 오디오 송신 ${sent}B, 수신 ${recv}B, dc=${S.dc && S.dc.readyState}`);
  DBG.peak = 0;
}, 5000);
window.addEventListener('error', e => dlog('JS 오류: ' + e.message));

// ===== 유틸 =====
function toast(msg, err = false, ms = 3500) {
  els.toast.textContent = msg; els.toast.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => els.toast.classList.add('hidden'), ms);
}
function setStatus(kind, text) { els.status.className = 'status ' + kind; els.status.querySelector('b').textContent = text; }
function hangulRatio(s) {
  const letters = s.replace(/[^A-Za-z가-힣ㄱ-ㆎ]/g, '');
  if (!letters.length) return 0;
  return (letters.match(/[가-힣ㄱ-ㆎ]/g) || []).length / letters.length;
}
const isKorean = s => hangulRatio(s) >= 0.5;
const hhmm = d => d.toTimeString().slice(0, 5);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function nearBottom() { const f = els.feed; return f.scrollHeight - f.scrollTop - f.clientHeight < 120; }
function scrollBottom(force) { if (force || nearBottom()) els.feed.scrollTop = els.feed.scrollHeight; }
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
function addUsage(usage, model) {
  if (!usage) return;
  const [pi, po] = TEXT_PRICES[model] || TEXT_PRICES[S.textModel] || [0.4, 1.6];
  S.textUsd += ((usage.prompt_tokens || 0) * pi + (usage.completion_tokens || 0) * po) / 1e6;
  renderCost();
}
function renderCost() {
  const usd = S.liveSeconds / 60 * PRICE_REALTIME_PER_MIN + S.textUsd;
  els.cost.textContent = '$' + usd.toFixed(3);
  els.costKrw.textContent = '≈ ' + Math.round(usd * KRW_PER_USD).toLocaleString() + '원';
  const t = Math.floor(S.liveSeconds), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  els.elapsed.textContent = (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ===== 회의 정보 (localStorage) =====
const CTX_FIELDS = { title: 'ctxTitle', place: 'ctxPlace', author: 'ctxAuthor', agenda: 'ctxAgenda', background: 'ctxBackground', participants: 'ctxParticipants', glossary: 'ctxGlossary', materials: 'ctxMaterials' };
function store(k, v) { try { localStorage.setItem(k, v); } catch {} }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function getCtx() { const c = {}; for (const [k, id] of Object.entries(CTX_FIELDS)) c[k] = $(id).value.trim(); return c; }
function saveCtx() {
  store('meetingCtx', JSON.stringify(getCtx()));
  store('opts', JSON.stringify({ v: 2, refine: $('optRefine').checked, noise: $('optNoise').value, mic: els.mic.value, src: $('srcSelect').value, muteShared: $('optMuteShared').checked }));
  $('meetingTitle').textContent = getCtx().title || '실시간 회의 통역';
}
function loadCtx() {
  try { const c = JSON.parse(load('meetingCtx') || '{}'); for (const [k, id] of Object.entries(CTX_FIELDS)) if (c[k]) $(id).value = c[k]; } catch {}
  try { const o = JSON.parse(load('opts') || '{}'); if (o.refine === false) $('optRefine').checked = false; if (o.noise && o.v === 2) $('optNoise').value = o.noise; if (o.src) $('srcSelect').value = o.src; if (o.muteShared === false) $('optMuteShared').checked = false; S.savedMic = o.mic; } catch {}
  updateSpeakerBtn();
  els.mic.disabled = $('srcSelect').value === 'tab' || $('srcSelect').value === 'file';
  $('meetingTitle').textContent = getCtx().title || '실시간 회의 통역';
}
// 음성 인식 힌트: 회의 제목, 참석자 이름, 용어집 원어 (고유명사 오인식 방지. 예: J PASS → JPEG)
function transcriptionHint() {
  const c = getCtx();
  const terms = (c.glossary || '').split(/\r?\n/).map(l => l.split('=')[0].trim()).filter(Boolean);
  return [c.title, c.participants, terms.join(', ')].filter(Boolean).join('. ').replace(/\s+/g, ' ').slice(0, 500);
}
function recentHistory() {
  return S.items.filter(i => i.src).slice(-HISTORY_FOR_CONTEXT).map(i => ({ lang: i.lang, src: i.src, tr: i.tr }));
}

// ===== 회의 자료 업로드 =====
function fileToBase64(file) {
  return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result.split(',')[1]); r.onerror = no; r.readAsDataURL(file); });
}
let pdfLoading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  return pdfLoading ||= new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; ok(); };
    s.onerror = () => no(new Error('PDF 해석기를 불러오지 못했습니다 (인터넷 연결 확인)'));
    document.head.appendChild(s);
  });
}
async function pdfText(file) {
  await loadPdfJs();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 80); i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    pages.push(`## ${i}쪽\n` + c.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
  }
  return pages.join('\n');
}
async function handleFiles(files) {
  for (const file of files) {
    const row = document.createElement('div');
    row.textContent = `⏳ ${file.name} — 읽는 중...`;
    $('fileList').appendChild(row);
    try {
      let text;
      if (/\.pdf$/i.test(file.name)) text = await pdfText(file);
      else text = (await api('/api/extract', { name: file.name, data: await fileToBase64(file) })).text;
      if (!text || !text.trim()) throw new Error('추출된 텍스트가 없습니다 (스캔 이미지 PDF일 수 있음)');
      row.textContent = `⏳ ${file.name} — ${text.length.toLocaleString()}자 추출, 브리핑 요약 중...`;
      const d = await api('/api/digest', { name: file.name, text });
      addUsage(d.usage, d.model);
      const box = $('ctxMaterials');
      box.value = (box.value.trim() ? box.value.trim() + '\n\n' : '') + `■ ${file.name}\n${d.text}`;
      saveCtx();
      row.className = 'ok'; row.textContent = `✓ ${file.name} — 브리핑 추가됨`;
    } catch (e) {
      row.className = 'err'; row.textContent = `✕ ${file.name} — ${e.message}`;
    }
  }
}
(function setupDrop() {
  const drop = $('drop'), input = $('fileInput');
  $('filePick').onclick = e => { e.preventDefault(); input.click(); };
  input.onchange = () => { handleFiles([...input.files]); input.value = ''; };
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => handleFiles([...e.dataTransfer.files]));
  // 모달 밖으로 떨어뜨려도 브라우저가 파일을 열지 않게
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
})();

// ===== 자막 렌더링 =====
function renderItem(it) {
  let el = document.getElementById('it' + it.id);
  if (!el) { el = document.createElement('div'); el.id = 'it' + it.id; els.history.appendChild(el); }
  const time = `<span>${hhmm(it.at)}</span>`;
  if (it.lang === 'ko') {
    el.className = 'card ko';
    el.innerHTML = `<div class="meta">${time}<span class="badge ko">${it.via === 'local' ? '한국어 발언 · 일시정지 중 기록' : '한국어 발언 · 번역 생략'}</span></div><div class="src">${esc(it.src)}</div>`;
  } else if (it.lang === 'me') {
    el.className = 'card me';
    el.innerHTML = `<div class="meta">${time}<span class="badge me">내 답변</span></div><div class="src">${esc(it.src)}</div><div class="tr">${esc(it.tr || '')}</div>`;
  } else {
    const badge = { interim: '임시', refining: '보정 중', final: '확정', failed: '임시 · 보정 실패', nosrc: '한국어 발언 추정 · 원문 없음' }[it.status];
    el.className = 'card en' + (it.status === 'final' ? '' : ' interim') + (it.status === 'nosrc' ? ' nosrc' : '');
    el.innerHTML = `<div class="meta">${time}<span class="badge ${it.status}">${badge}</span></div><div class="src">${esc(it.src || (it.status === 'refining' ? '(원문 기다리는 중)' : '(영어 원문 없음)'))}</div><div class="tr">${esc(it.tr || '…')}</div>`;
  }
  persistItems();
  return el;
}
let persistT = null;
function persistItems() {
  clearTimeout(persistT);
  persistT = setTimeout(() => store('items', JSON.stringify(S.items.slice(-2000).map(i => ({ id: i.id, lang: i.lang, src: i.src, tr: i.tr, draft: i.draft, status: i.status, via: i.via, at: i.at.getTime() })))), 500);
}
function restoreItems() {
  try {
    const arr = JSON.parse(load('items') || '[]');
    for (const o of arr) {
      const it = { ...o, at: new Date(o.at), status: o.status === 'refining' ? 'interim' : o.status };
      S.items.push(it); S.seq = Math.max(S.seq, it.id); renderItem(it);
    }
    if (arr.length) { els.empty.classList.add('hidden'); scrollBottom(true); }
  } catch {}
}
function renderLive() {
  const { src, tr } = S.seg;
  if (!src && !tr) { els.live.classList.add('hidden'); return; }
  els.empty.classList.add('hidden');
  els.live.classList.remove('hidden');
  const ko = !!src && isKorean(src);
  els.liveSrc.textContent = src;
  els.liveTr.textContent = ko ? '' : tr;
  els.live.querySelector('.badge').textContent = ko ? '한국어 발언 듣는 중' : '듣는 중';
  scrollBottom();
}

// ===== 문장 확정 + 문맥 보정 =====
// 쉬지 않고 말할 때: 번역문이 길어지면 마지막 문장 끝에서 잘라 앞부분을 확정한다
function lastSentenceEnd(s, min) {
  let idx = -1; const re = /[.?!。]["'”’)]?(?=\s)/g; let m;
  while ((m = re.exec(s))) if (m.index + m[0].length >= min) idx = m.index + m[0].length;
  return idx;
}
function splitLongSeg() {
  const { src, tr } = S.seg;
  if (tr.length < SPLIT_TR_CHARS) return;
  const ti = lastSentenceEnd(tr, 25);
  if (ti < 0) return;
  // 원문과 번역을 같은 문장 경계에서 자른다. 원문에 문장 끝이 아직 없으면 원문 전체가 앞 카드로 가고
  // 번역 뒷부분만 다음 카드로 넘어가 짝이 어긋나므로, 아주 길어질 때까지 기다린다.
  const si = src ? lastSentenceEnd(src, 30) : -1;
  if (src && si < 0 && tr.length < SPLIT_FORCE_CHARS) return;
  const head = { src: si > 0 ? src.slice(0, si) : src, tr: tr.slice(0, ti) };
  const rest = { src: si > 0 ? src.slice(si) : '', tr: tr.slice(ti), last: S.seg.last };
  S.seg = { src: head.src, tr: head.tr, last: S.seg.last };
  finalizeSeg();
  S.seg = { src: rest.src.replace(/^\s+/, ''), tr: rest.tr.replace(/^\s+/, ''), last: rest.last };
  renderLive();
}
function finalizeSeg() {
  const { src, tr } = S.seg;
  S.seg = newSeg();
  renderLive();
  const s = src.trim(), t = tr.trim();
  if (!s && !t) return;
  const wasBottom = nearBottom();
  // 한국어 발언 판정: 원문 인식 결과 기준 (인식이 없으면 번역문으로는 판단하지 않음)
  if (s && isKorean(s)) {
    const it = { id: ++S.seq, lang: 'ko', src: s, at: new Date() };
    S.items.push(it); renderItem(it); scrollBottom(wasBottom);
    return;
  }
  // 원문이 없으면 대부분 한국어 발언이다 (번역 세션은 한국어 음성의 원문을 주지 않고 한국어 문장만 낸다, 10/28 테스트로 확인).
  // 영어 원문이 늦게 오면 flushLate가 영어 카드로 바꾼다. 그 전까지는 보정·확정하지 않는다.
  const it = { id: ++S.seq, lang: 'en', src: s, tr: t, draft: t, status: s ? 'interim' : 'nosrc', at: new Date() };
  it.history = recentHistory();
  S.items.push(it); renderItem(it); scrollBottom(wasBottom);
  S.lastEn = it;
  if (!s) return; // 늦게 원문이 도착하면 attachLateSrc가 보정을 시작한다
  if ($('optRefine').checked) { it.status = 'refining'; renderItem(it); it.timer = setTimeout(() => refine(it), 300); }
  else if (!t) { it.tr = '(번역 없음)'; renderItem(it); }
}
// 원문 스트림은 번역보다 늦게, 몰아서 오는 경우가 많다 (10/28: 미인식 카드 뒤 확정 카드에 앞 문장들 원문이 뭉쳐 붙음).
// 미인식 카드가 남아 있는 동안 들어온 원문은 따로 모았다가, 원문이 잠잠해지면 미인식 카드들을 한 카드로 합쳐 붙이고 다시 보정한다.
const LATE_GROUP_MS = 30000; // 이보다 오래된 미인식 카드에는 붙이지 않는다
const LATE_FLUSH_MS = 1500;  // 원문이 이만큼 안 들어오면 모은 원문을 붙인다
const LATE_MAX_MS = 25000;   // 계속 말해도 이 시간이 지나면 붙인다
function newLate() { return { src: '', last: 0, at: 0 }; }
function pendingNosrc() {
  const out = [];
  for (let i = S.items.length - 1; i >= 0; i--) {
    const it = S.items[i];
    if (it.lang !== 'en' || it.status !== 'nosrc' || Date.now() - it.at.getTime() > LATE_GROUP_MS || it.at.getTime() < (S.lateCutoff || 0)) break;
    out.unshift(it);
  }
  return out;
}
function addLateSrc(delta) {
  if (!S.late.src) S.late.at = performance.now();
  S.late.src += delta; S.late.last = performance.now();
  const first = pendingNosrc()[0];
  const el = first && document.getElementById('it' + first.id);
  if (el) el.querySelector('.src').textContent = S.late.src.trim();
}
function flushLate() {
  const src = S.late.src.trim();
  S.late = newLate();
  if (!src) return;
  const group = pendingNosrc();
  if (!group.length) { S.seg.src = (src + ' ' + S.seg.src).trim(); S.seg.last = performance.now(); renderLive(); return; }
  const [first, ...rest] = group;
  first.tr = first.draft = group.map(i => i.tr).filter(Boolean).join(' ');
  first.src = src; first.status = 'interim';
  if (rest.length) {
    const ids = new Set(rest.map(i => i.id));
    S.items = S.items.filter(i => !ids.has(i.id));
    rest.forEach(i => { const el = document.getElementById('it' + i.id); if (el) el.remove(); });
  }
  S.lastEn = first;
  dlog(`늦은 원문 ${src.length}자 → 미인식 카드 ${group.length}개를 묶어 보정`);
  renderItem(first);
  if ($('optRefine').checked) refine(first);
}
// 문장 확정 뒤에 늦게 도착한 원문 → 직전 카드에 붙이고 다시 보정
// 한국어 발언이나 시간이 지난 원문은 다른 문장이므로 붙이지 않는다 (원문·번역 짝이 어긋나는 원인)
const LATE_SRC_MS = 4000, LATE_SRC_NOSRC_MS = 10000;
function attachLateSrc(delta) {
  const it = S.lastEn;
  if (!it || /[가-힣]/.test(delta) || it.at.getTime() < (S.lateCutoff || 0)) return false;
  const age = Date.now() - it.at.getTime();
  if (age > (it.src ? LATE_SRC_MS : LATE_SRC_NOSRC_MS)) return false;
  it.src = (it.src + delta).replace(/^\s+/, '');
  if (it.status === 'nosrc') it.status = 'interim';
  renderItem(it);
  if ($('optRefine').checked) { clearTimeout(it.timer); it.status = 'refining'; renderItem(it); it.timer = setTimeout(() => refine(it), 1500); }
  return true;
}
async function refine(it) {
  if (!it.src) { it.status = 'nosrc'; renderItem(it); return; }
  const reqId = (it.reqId || 0) + 1; it.reqId = reqId;
  it.status = 'refining'; renderItem(it);
  try {
    const d = await api('/api/translate', { mode: 'refine', text: it.src, draft: it.draft, context: getCtx(), history: it.history });
    if (it.reqId !== reqId) return; // 더 최신 보정 요청이 있음
    addUsage(d.usage, d.model);
    const wasBottom = nearBottom();
    it.tr = d.text || it.draft; it.status = 'final';
    const el = renderItem(it);
    if (it.tr !== it.draft) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900); }
    scrollBottom(wasBottom);
  } catch (e) {
    it.status = 'failed'; renderItem(it);
    console.warn('보정 실패', e);
  }
}

// ===== 실시간 이벤트 처리 =====
function handleEvent(ev) {
  switch (ev.type) {
    case 'session.input_transcript.delta':
      S.lastInAt = performance.now(); S.outSinceIn = 0;
      if (!S.seg.src && !/[가-힣]/.test(ev.delta || '') && (S.late.src || pendingNosrc().length)) { addLateSrc(ev.delta || ''); break; }
      if (!S.seg.src && !S.seg.tr && attachLateSrc(ev.delta || '')) break;
      S.seg.src += ev.delta || ''; S.seg.last = performance.now(); renderLive(); break;
    case 'session.output_transcript.delta':
      S.outSinceIn = (S.outSinceIn || 0) + 1;
      S.seg.tr += ev.delta || ''; S.seg.last = performance.now(); renderLive(); break;
    case 'session.created': case 'session.updated':
      break;
    case 'session.closed':
      if (!S.userStopped) scheduleReconnect('세션 종료됨'); break;
    case 'error':
      console.error('서버 오류', ev.error);
      toast('번역 서버 오류: ' + (ev.error && ev.error.message || '알 수 없음'), true, 6000); break;
  }
}
window.__handleEvent = handleEvent; // 테스트용

function tick() {
  const now = performance.now(), dt = (now - S.lastTick) / 1000; S.lastTick = now;
  if (S.state === 'live' || S.state === 'reconnecting') { S.liveSeconds += dt; }
  renderCost();
  const { src, tr, last } = S.seg;
  if ((src || tr) && last) {
    if (now - last > IDLE_MS) finalizeSeg();
    else splitLongSeg();
  }
  if (S.late.src && ((!S.seg.tr && now - S.late.last > LATE_FLUSH_MS) || now - S.late.at > LATE_MAX_MS)) flushLate();
  // 원문 인식 스트림만 멈추는 경우가 있다 (10/28 회의: 원문 미인식 81건). 감지하면 세션을 새로 연다.
  if (S.state === 'live' && (S.outSinceIn || 0) >= STALL_OUT_DELTAS && now - (S.lastInAt || now) > STALL_MS
      && now - (S.lastStallFix || 0) > STALL_COOLDOWN_MS) {
    S.lastStallFix = now;
    dlog(`원문 인식 정지 감지: 번역 ${S.outSinceIn}건 동안 원문 없음 → 재연결`);
    toast('원문 인식이 멈춰 연결을 새로 엽니다 (1~2초)', false, 4000);
    finalizeSeg();
    S.reconnectTries = 0;
    scheduleReconnect('원문 인식 정지');
  }
  if (S.analyser) {
    const buf = new Uint8Array(S.analyser.fftSize); S.analyser.getByteTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    els.meter.style.width = Math.min(100, peak / 128 * 220) + '%';
    DBG.peak = Math.max(DBG.peak, peak / 128 * 100);
  } else els.meter.style.width = '0';
}
setInterval(tick, 200);

// ===== 마이크 =====
async function listMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const cur = els.mic.value || S.savedMic || '';
    const list = devs.filter(d => d.deviceId && d.deviceId !== 'communications');
    els.mic.innerHTML = list.length && list.some(d => d.label)
      ? list.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || '마이크 ' + d.deviceId.slice(0, 6))}</option>`).join('')
      : '<option value="default">기본 마이크</option>';
    if ([...els.mic.options].some(o => o.value === cur)) els.mic.value = cur;
  } catch {}
}
async function openMic(mixed) {
  const deviceId = els.mic.value || 'default'; // 'default' = Windows 기본 장치
  // 회의 소리와 섞을 때는 내 목소리만 받도록 브라우저 노이즈 억제를 켠다 (헤드셋 권장)
  const opts = id => ({ audio: { deviceId: { exact: id }, echoCancellation: !!mixed, noiseSuppression: !!mixed, autoGainControl: true, channelCount: 1 } });
  try { S.stream = await navigator.mediaDevices.getUserMedia(opts(deviceId)); }
  catch (e) {
    if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
    dlog('선택한 마이크 없음 → 기본 마이크 사용'); S.stream = await navigator.mediaDevices.getUserMedia(opts('default'));
  }
  listMics();
  const tr = S.stream.getAudioTracks()[0];
  dlog(`마이크 열림: ${tr && tr.label} / ${JSON.stringify(tr && tr.getSettings())}`);
}
// 회의 탭·화면 소리를 직접 받는다. 스피커 → 마이크로 다시 녹음하지 않으므로 인식률이 훨씬 높다.
async function openDisplayAudio() {
  if (!navigator.mediaDevices.getDisplayMedia) throw new Error('이 브라우저는 탭·화면 소리 공유를 지원하지 않습니다 (Chrome/Edge 사용)');
  const disp = await navigator.mediaDevices.getDisplayMedia({
    video: true, // Chrome은 영상 없이 오디오만 공유할 수 없다. 영상 트랙은 끄고 쓰지 않는다.
    // suppressLocalAudioPlayback: 탭 소리를 캡처만 하고 노트북 스피커로는 내지 않는다 (회의실 하울링·이중 소리 방지)
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: $('optMuteShared').checked },
    systemAudio: 'include', selfBrowserSurface: 'exclude',
  });
  disp.getVideoTracks().forEach(t => { t.enabled = false; });
  const at = disp.getAudioTracks()[0];
  if (!at) {
    disp.getTracks().forEach(t => t.stop());
    throw new Error('공유 창에서 "오디오 공유"를 켜지 않았습니다. 회의 탭(또는 전체 화면)을 고르고 오디오 공유를 체크하세요.');
  }
  at.onended = () => { if (!S.userStopped) { toast('회의 소리 공유가 끝났습니다. 다시 시작하세요.', true, 8000); els.btnStop.click(); } };
  S.dispStream = disp;
  // 전체 화면 공유(System Audio)는 노트북 소리 켜기/끄기를 공유 시작 때만 정할 수 있다 (Chrome 제약)
  S.dispSystem = /^loopback/.test(at.getSettings().deviceId || '');
  dlog(`회의 소리 공유: ${at.label} / ${JSON.stringify(at.getSettings())}`);
}
// ===== 녹음 파일 재생하며 통역 =====
// 오디오 요소는 한 번만 AudioContext에 연결할 수 있으므로 파일용 컨텍스트는 파일을 바꿀 때까지 유지한다
const FileSrc = { file: null, url: '', ctx: null, dest: null };
function fileMode() { return $('srcSelect').value === 'file'; }
function updateFileUi() {
  const on = fileMode();
  $('btnPickFile').classList.toggle('hidden', !on);
  $('fileBar').classList.toggle('hidden', !on || !FileSrc.file);
  els.mic.disabled = $('srcSelect').value === 'tab' || on;
}
function setAudioFile(file) {
  if (!file) return;
  const el = $('fileAudio');
  el.pause();
  if (FileSrc.url) URL.revokeObjectURL(FileSrc.url);
  if (FileSrc.ctx) { FileSrc.ctx.close().catch(() => {}); FileSrc.ctx = null; FileSrc.dest = null; }
  // 요소를 새로 만들어야 다른 컨텍스트에 다시 연결할 수 있다
  const fresh = el.cloneNode(false); el.replaceWith(fresh);
  FileSrc.file = file; FileSrc.url = URL.createObjectURL(file);
  fresh.src = FileSrc.url;
  fresh.onended = () => { if (S.state === 'live' && fileMode()) { toast('녹음 파일 재생이 끝나 통역을 종료합니다.', false, 6000); els.btnStop.click(); } };
  $('fileName').textContent = file.name; $('fileName').title = file.name;
  updateFileUi();
  toast(`녹음 파일: ${file.name} — 통역 시작을 누르면 재생과 함께 통역합니다.`, false, 6000);
}
$('btnPickFile').onclick = () => $('audioFile').click();
$('audioFile').onchange = () => { setAudioFile($('audioFile').files[0]); $('audioFile').value = ''; };
async function openFileAudio() {
  if (!FileSrc.file) throw new Error('녹음 파일을 먼저 고르세요 (파일 선택 버튼).');
  const el = $('fileAudio');
  if (!FileSrc.ctx) {
    FileSrc.ctx = new AudioContext();
    const srcNode = FileSrc.ctx.createMediaElementSource(el);
    FileSrc.dest = FileSrc.ctx.createMediaStreamDestination();
    srcNode.connect(FileSrc.dest);
    srcNode.connect(FileSrc.ctx.destination); // 스피커로도 들려준다
  }
  await FileSrc.ctx.resume();
  S.analyser = FileSrc.ctx.createAnalyser(); S.analyser.fftSize = 512;
  FileSrc.ctx.createMediaStreamSource(FileSrc.dest.stream).connect(S.analyser);
  S.sendTrack = FileSrc.dest.stream.getAudioTracks()[0];
  dlog('녹음 파일 통역: ' + FileSrc.file.name + ' @' + el.currentTime.toFixed(1) + 's');
}
async function openAudio() {
  const mode = $('srcSelect').value;
  if (mode === 'file') return openFileAudio();
  if (mode !== 'mic') await openDisplayAudio();
  if (mode !== 'tab') await openMic(mode === 'mix');
  S.audioCtx = new AudioContext();
  const dest = S.audioCtx.createMediaStreamDestination();
  S.mixDest = dest;
  if (S.dispStream) attachDispAudio();
  if (S.stream) S.audioCtx.createMediaStreamSource(S.stream).connect(dest);
  S.analyser = S.audioCtx.createAnalyser(); S.analyser.fftSize = 512;
  S.audioCtx.createMediaStreamSource(dest.stream).connect(S.analyser);
  // 마이크만 쓸 때는 원본 트랙을 그대로 보낸다 (불필요한 재샘플링 방지)
  S.sendTrack = mode === 'mic' ? S.stream.getAudioTracks()[0] : dest.stream.getAudioTracks()[0];
}
// 공유한 회의 소리를 송신 믹스에 연결한다. 송신 트랙(mixDest)은 그대로라 공유를 바꿔도 통역 연결은 유지된다.
function attachDispAudio() {
  S.dispSrc = S.audioCtx.createMediaStreamSource(new MediaStream(S.dispStream.getAudioTracks()));
  S.dispSrc.connect(S.mixDest);
  // 탭 공유를 노트북 소리 끔으로 시작했으면, 탭 소리를 여기서 직접 재생해 공유 중에도 켜고 끌 수 있게 한다
  if (!S.dispSystem && S.dispStream.getAudioTracks()[0].getSettings().suppressLocalAudioPlayback) {
    S.monitorGain = S.audioCtx.createGain();
    S.monitorGain.gain.value = $('optMuteShared').checked ? 0 : 1;
    S.dispSrc.connect(S.monitorGain).connect(S.audioCtx.destination);
  }
}
// 공유 중 노트북 소리 설정을 바꿀 수 없는 경우 (전체 화면 공유 등): 바뀐 설정으로 공유를 다시 받아 소리 입력만 갈아 끼운다
async function reshareDisplay(muted) {
  const old = S.dispStream;
  $('optMuteShared').checked = muted;
  try { await openDisplayAudio(); }
  catch (e) {
    $('optMuteShared').checked = !muted;
    dlog('공유 다시 받기 실패: ' + e.name + ' ' + e.message);
    toast('공유를 다시 받지 못해 노트북 소리 설정을 그대로 둡니다. (통역은 계속됩니다)', true, 6000);
    return;
  }
  old.getAudioTracks().forEach(t => { t.onended = null; }); old.getTracks().forEach(t => t.stop());
  if (S.dispSrc) S.dispSrc.disconnect();
  if (S.monitorGain) S.monitorGain.disconnect();
  S.monitorGain = null;
  attachDispAudio();
  saveCtx(); updateSpeakerBtn();
  toast(muted ? '노트북 소리 꺼짐 (통역에만 씀)' : '노트북 소리 켜짐');
}
function closeAudio() {
  if (FileSrc.file) { try { $('fileAudio').pause(); } catch {} }
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  if (S.dispStream) { S.dispStream.getAudioTracks().forEach(t => { t.onended = null; }); S.dispStream.getTracks().forEach(t => t.stop()); }
  S.stream = null; S.dispStream = null; S.sendTrack = null; S.analyser = null; S.monitorGain = null; S.dispSystem = false; S.dispSrc = null; S.mixDest = null;
  if (S.audioCtx) { S.audioCtx.close().catch(() => {}); S.audioCtx = null; }
}
navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener('devicechange', listMics);
els.mic.onchange = async () => {
  saveCtx();
  if (S.state === 'live' && $('srcSelect').value !== 'tab') { toast('마이크 변경 → 다시 연결합니다'); await disconnect(); closeAudio(); await connect(); }
};
$('srcSelect').onchange = () => {
  saveCtx();
  updateFileUi();
  if (fileMode() && !FileSrc.file) $('audioFile').click();
  if (S.state === 'live') toast('소리 입력 방식은 일시정지 후 다시 시작하면 적용됩니다');
};

// ===== WebRTC 연결 =====
async function connect() {
  stopKoRec();
  clearTimeout(S.reconnectTimer);
  S.state = S.state === 'reconnecting' ? 'reconnecting' : 'connecting';
  setStatus('wait', S.state === 'reconnecting' ? '재연결 중' : '연결 중');
  updateButtons();
  try {
    if (!S.sendTrack) await openAudio();
    const pc = new RTCPeerConnection();
    S.pc = pc;
    pc.addTrack(S.sendTrack);
    pc.ontrack = () => { /* 번역 음성은 재생하지 않음 */ };
    const dc = pc.createDataChannel('oai-events');
    S.dc = dc;
    dc.onmessage = e => {
      try {
        const ev = JSON.parse(e.data);
        DBG.counts[ev.type] = (DBG.counts[ev.type] || 0) + 1; DBG.dirty = true;
        if (DBG.raw++ < 40) dlog('수신: ' + String(e.data).slice(0, 400));
        handleEvent(ev);
      } catch (err) { dlog('수신 처리 오류: ' + err.message + ' / ' + String(e.data).slice(0, 200)); }
    };
    dc.onopen = () => {
      dlog('데이터채널 열림');
      if (S.pc !== pc) return;
      S.state = 'live'; S.reconnectTries = 0;
      if (fileMode() && FileSrc.file) $('fileAudio').play().catch(e => toast('녹음 파일을 재생하지 못했습니다: ' + e.message, true));
      S.lastInAt = performance.now(); S.outSinceIn = 0;
      setStatus('ok', '통역 중'); updateButtons();
    };
    dc.onclose = () => { dlog('데이터채널 닫힘'); if (S.pc === pc && !S.userStopped && S.state !== 'paused') scheduleReconnect('연결 끊김'); };
    pc.onconnectionstatechange = () => {
      if (S.pc !== pc) return;
      const st = pc.connectionState;
      dlog('연결 상태: ' + st);
      if ((st === 'failed' || st === 'disconnected' || st === 'closed') && !S.userStopped && S.state !== 'paused') scheduleReconnect('네트워크 ' + st);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    dlog('offer 생성, 서버로 전송');
    // 회의 소리를 직접 받을 때는 원음이 깨끗하므로 근거리 노이즈 제거만 쓴다
    const noise = $('srcSelect').value === 'mic' ? $('optNoise').value : 'near_field';
    const { sdp } = await api('/api/rtc', { sdp: offer.sdp, noise, hint: transcriptionHint() });
    if (S.pc !== pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
    dlog('answer 적용 완료');
  } catch (e) {
    console.error(e);
    dlog('연결 오류: ' + e.name + ' ' + e.message);
    if (/Permission|NotAllowed/i.test(e.name + e.message)) {
      S.userStopped = true; await disconnect(); closeAudio(); S.state = 'idle';
      const share = $('srcSelect').value !== 'mic';
      setStatus('bad', share ? '공유 취소됨' : '마이크 권한 없음'); updateButtons();
      toast(share ? '회의 소리 공유가 취소됐습니다. 통역 시작을 다시 누르고 회의 탭을 고르세요.' : '마이크 권한을 허용해 주세요 (주소창 왼쪽 자물쇠 아이콘)', true, 7000);
      return;
    }
    if (/오디오 공유|지원하지 않습니다/.test(e.message)) {
      S.userStopped = true; await disconnect(); closeAudio(); S.state = 'idle';
      setStatus('bad', '회의 소리 없음'); updateButtons(); toast(e.message, true, 9000);
      return;
    }
    if (/API 키/.test(e.message)) { S.userStopped = true; S.state = 'idle'; setStatus('bad', 'API 키 없음'); updateButtons(); showKeyModal(); return; }
    toast('연결 실패: ' + e.message, true, 7000);
    scheduleReconnect('연결 실패');
  }
}
async function disconnect() {
  const pc = S.pc; S.pc = null; S.dc = null;
  if (pc) { try { pc.close(); } catch {} }
}
function scheduleReconnect(reason) {
  if (S.userStopped || S.state === 'paused') return;
  if (S.reconnectTimer && S.state === 'reconnecting') return;
  // 새 세션의 원문은 끊기기 전 미인식 카드와 다른 발언이다 (10/28 테스트: 재연결 뒤 'before' 한 단어가 카드 4개에 붙음)
  flushLate(); S.lateCutoff = Date.now();
  disconnect();
  S.state = 'reconnecting';
  S.reconnectTries++;
  if (S.reconnectTries > 8) { S.userStopped = true; S.state = 'idle'; setStatus('bad', '연결 실패'); updateButtons(); toast('재연결을 여러 번 실패했습니다. 인터넷과 API 키를 확인한 뒤 다시 시작하세요.', true, 9000); return; }
  const wait = Math.min(8000, 500 * 2 ** (S.reconnectTries - 1));
  setStatus('wait', `재연결 중 (${reason})`); updateButtons();
  S.reconnectTimer = setTimeout(() => { S.reconnectTimer = null; connect(); }, wait);
}

// ===== 일시정지 중 한국어 기록 (Chrome 내장 음성 인식, 무료 · OpenAI로 보내지 않음) =====
const KoRec = { rec: null, want: false };
function koRecLive(text) {
  if (!text) { els.live.classList.add('hidden'); return; }
  els.empty.classList.add('hidden'); els.live.classList.remove('hidden');
  els.live.querySelector('.badge').textContent = '한국어 기록 중 (무료)';
  els.liveSrc.textContent = text; els.liveTr.textContent = '';
  scrollBottom();
}
function startKoRec() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { dlog('브라우저 음성 인식 미지원'); return false; }
  KoRec.want = true;
  if (KoRec.rec) return true;
  const rec = new SR();
  rec.lang = 'ko-KR'; rec.continuous = true; rec.interimResults = true;
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i], text = r[0].transcript.trim();
      if (r.isFinal) {
        koRecLive('');
        if (text.length < 2) continue;
        const wasBottom = nearBottom();
        const it = { id: ++S.seq, lang: 'ko', src: text, at: new Date(), via: 'local' };
        S.items.push(it); renderItem(it); scrollBottom(wasBottom);
      } else interim += text + ' ';
    }
    if (interim.trim()) koRecLive(interim.trim());
  };
  rec.onerror = e => { dlog('한국어 기록 오류: ' + e.error); if (e.error === 'not-allowed') KoRec.want = false; };
  rec.onend = () => { KoRec.rec = null; koRecLive(''); if (KoRec.want) setTimeout(() => KoRec.want && startKoRec(), 300); }; // 무음으로 끊기면 자동 재시작
  try { rec.start(); KoRec.rec = rec; } catch (e) { dlog('한국어 기록 시작 실패: ' + e.message); return false; }
  return true;
}
function stopKoRec() {
  KoRec.want = false;
  if (KoRec.rec) { try { KoRec.rec.stop(); } catch {} KoRec.rec = null; }
  koRecLive('');
}

// ===== 버튼 =====
function updateButtons() {
  const st = S.state;
  els.btnStart.disabled = st === 'connecting' || st === 'live' || st === 'reconnecting';
  els.btnStart.textContent = st === 'paused' ? '다시 시작' : '통역 시작';
  els.btnPause.disabled = st !== 'live';
  els.btnStop.disabled = st === 'idle';
}
els.btnStart.onclick = async () => {
  if (fileMode() && !FileSrc.file) { $('audioFile').click(); toast('통역할 녹음 파일을 고르세요.'); return; }
  saveCtx();
  const st = await api('/api/status').catch(() => null);
  if (!st) { toast('로컬 서버에 연결할 수 없습니다. start.bat 창이 켜져 있는지 확인하세요.', true, 7000); return; }
  if (!st.hasKey) { showKeyModal(); return; }
  S.textModel = st.textModel;
  // 지난 회의 기록이 남아 있으면 새 회의 기록과 섞이지 않게 정리 (10/28: 아침 테스트 기록 때문에 회의록 일시가 08:57로 잡힘)
  const lastItem = S.items[S.items.length - 1];
  if (S.state !== 'paused' && lastItem && Date.now() - lastItem.at.getTime() > NEW_MEETING_GAP_MS
      && confirm(`이전 회의 기록 ${S.items.length}건이 남아 있습니다 (마지막 ${lastItem.at.toLocaleString('ko-KR')}).\n지우고 새 회의를 시작할까요? (취소 = 기록 유지)`)) {
    S.items = []; els.history.innerHTML = ''; store('items', '[]');
  }
  S.userStopped = false; S.reconnectTries = 0;
  els.empty.classList.add('hidden');
  await connect();
};
els.btnPause.onclick = async () => {
  S.state = 'paused'; finalizeSeg(); flushLate();
  await disconnect(); closeAudio();
  const ko = fileMode() ? false : startKoRec();
  setStatus('paused', ko ? '일시정지 · 한국어만 기록 중 (무료)' : '일시정지 (과금 안 됨)'); updateButtons();
};
els.btnStop.onclick = async () => {
  S.userStopped = true; clearTimeout(S.reconnectTimer); S.reconnectTimer = null;
  stopKoRec(); finalizeSeg(); flushLate();
  await disconnect(); closeAudio();
  S.state = 'idle'; setStatus('', '종료됨'); updateButtons();
  toast(`통역 종료 · 사용 ${els.elapsed.textContent} · 예상 ${els.cost.textContent} (${els.costKrw.textContent})`, false, 8000);
};

// ===== 한국어 답변 → 영어 =====
let replyBusy = false;
async function translateReply() {
  const text = els.replyInput.value.trim();
  if (!text || replyBusy) return;
  replyBusy = true;
  els.replyOut.className = 'out loading'; els.replyOut.textContent = '번역 중...'; els.btnCopy.disabled = true;
  try {
    const d = await api('/api/translate', { mode: 'reply', text, context: getCtx(), history: recentHistory() });
    addUsage(d.usage, d.model);
    els.replyOut.className = 'out'; els.replyOut.textContent = d.text;
    els.btnCopy.disabled = false; els.btnCopy.textContent = '복사';
    const it = { id: ++S.seq, lang: 'me', src: text, tr: d.text, at: new Date() };
    S.items.push(it); els.empty.classList.add('hidden'); renderItem(it); scrollBottom(true);
    els.replyInput.value = '';
  } catch (e) {
    els.replyOut.className = 'out'; els.replyOut.textContent = '';
    if (/API 키/.test(e.message)) showKeyModal(); else toast('번역 실패: ' + e.message, true);
  } finally { replyBusy = false; }
}
els.replyInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); translateReply(); }
});
els.btnCopy.onclick = async () => {
  const t = els.replyOut.textContent;
  try { await navigator.clipboard.writeText(t); }
  catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  els.btnCopy.textContent = '복사됨 ✓';
  setTimeout(() => (els.btnCopy.textContent = '복사'), 1500);
};

// ===== 모달 =====
$('btnInfo').onclick = () => $('infoModal').classList.remove('hidden');
$('btnInfoClose').onclick = () => { saveCtx(); $('infoModal').classList.add('hidden'); toast('회의 정보 저장됨'); };
$('infoModal').addEventListener('mousedown', e => { if (e.target.id === 'infoModal') { saveCtx(); $('infoModal').classList.add('hidden'); } });
Object.values(CTX_FIELDS).forEach(id => $(id).addEventListener('change', saveCtx));
$('optRefine').onchange = saveCtx; $('optNoise').onchange = saveCtx;
// ===== 노트북 스피커 켜기/끄기 (공유한 회의 소리) =====
function updateSpeakerBtn() {
  const muted = $('optMuteShared').checked;
  const b = $('btnSpeaker');
  b.textContent = muted ? '🔇' : '🔊';
  b.classList.toggle('muted', muted);
  b.title = muted ? '노트북 소리 꺼짐 · 공유한 회의 소리를 통역에만 씁니다 (클릭하면 켜짐)' : '노트북 소리 켜짐 · 공유한 회의 소리를 스피커로도 냅니다 (클릭하면 꺼짐)';
  b.setAttribute('aria-label', muted ? '노트북 소리 켜기' : '노트북 소리 끄기');
}
$('btnSpeaker').onclick = () => {
  const muted = !$('optMuteShared').checked;
  // 공유 중인데 직접 재생 경로가 없으면 (전체 화면 공유, 또는 소리 켬으로 시작한 탭 공유) Chrome이 설정 변경을 막으므로 공유를 다시 받는다
  if (S.dispStream && S.mixDest && !S.monitorGain) {
    dlog(`스피커 전환: ${S.dispSystem ? '전체 화면(System Audio)' : '탭(소리 켬으로 시작)'} 공유 다시 받기`);
    toast('공유 창이 다시 뜹니다. 같은 화면(또는 탭)을 고르고 오디오 공유를 켜세요.', false, 6000);
    reshareDisplay(muted);
    return;
  }
  $('optMuteShared').checked = muted; saveCtx(); updateSpeakerBtn();
  if (S.monitorGain) S.monitorGain.gain.value = muted ? 0 : 1;
  toast(muted ? '노트북 소리 꺼짐 (통역에만 씀)' : '노트북 소리 켜짐');
};
$('btnClearHistory').onclick = () => {
  if (!confirm('화면의 대화 기록을 모두 지울까요? (회의 정보는 유지)')) return;
  S.items = []; els.history.innerHTML = ''; store('items', '[]'); toast('대화 기록을 지웠습니다');
};
function transcriptLines() {
  const c = getCtx();
  const lines = [`# ${c.title || '회의'} 통역 기록 (${new Date().toLocaleString('ko-KR')})`, ''];
  for (const it of S.items) {
    const t = hhmm(it.at);
    if (it.lang === 'ko') lines.push(`[${t}] (한국어) ${it.src}`);
    else if (it.lang === 'me') lines.push(`[${t}] (내 답변) ${it.src}\n         → ${it.tr}`);
    else if (!it.src) lines.push(`[${t}] KO(추정): ${it.tr} (한국어 발언 추정 · 영어 원문 없음)`);
    else lines.push(`[${t}] EN: ${it.src}\n         KO: ${it.tr}${it.status === 'final' ? '' : ' (임시)'}`);
  }
  lines.push('', `사용 시간 ${els.elapsed.textContent} · 예상 비용 ${els.cost.textContent} (${els.costKrw.textContent})`);
  return lines;
}
$('btnExport').onclick = () => {
  const blob = new Blob(['\uFEFF' + transcriptLines().join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `통역기록_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

// ===== 새 회의 (보관 + 초기화) =====
const NEW_CLEAR_FIELDS = ['title', 'place', 'agenda', 'background', 'participants', 'materials'];
$('btnNew').onclick = () => {
  const n = S.items.length, title = getCtx().title;
  $('newSummary').textContent = n
    ? `지금 기록 ${n}건${title ? ` (${title})` : ''}을 정리하고 새 회의를 시작합니다.${S.state !== 'idle' ? ' 진행 중인 통역은 종료됩니다.' : ''}`
    : '남아 있는 통역 기록이 없습니다. 회의 정보만 정리하고 시작합니다.';
  $('newArchive').checked = n > 0; $('newArchive').disabled = n === 0;
  $('newModal').classList.remove('hidden');
};
$('btnNewCancel').onclick = () => $('newModal').classList.add('hidden');
$('newModal').addEventListener('mousedown', e => { if (e.target.id === 'newModal') $('newModal').classList.add('hidden'); });
$('btnNewOk').onclick = async () => {
  const btn = $('btnNewOk'); btn.disabled = true;
  let archived = '';
  try {
    // 1) 진행 중인 통역 종료
    if (S.state !== 'idle') {
      S.userStopped = true; clearTimeout(S.reconnectTimer); S.reconnectTimer = null;
      stopKoRec(); finalizeSeg(); flushLate();
      await disconnect(); closeAudio();
      S.state = 'idle'; setStatus('', '대기'); updateButtons();
    }
    // 2) 보관
    if ($('newArchive').checked && S.items.length) {
      try {
        const r = await api('/api/archive', { title: getCtx().title || '회의', text: transcriptLines().join('\r\n') });
        archived = ' 이전 기록은 기록 폴더에 보관했습니다 (' + r.file + ').';
      } catch (e) {
        if (!confirm('기록 보관에 실패했습니다 (' + e.message + ').\n그래도 지우고 새 회의를 시작할까요?')) return;
      }
    }
    // 3) 초기화
    S.items = []; els.history.innerHTML = ''; store('items', '[]');
    S.seg = newSeg(); renderLive();
    S.liveSeconds = 0; S.textUsd = 0; renderCost();
    els.replyInput.value = ''; els.replyOut.className = 'out'; els.replyOut.innerHTML = '<span class="ph">번역 결과가 여기에 표시됩니다.</span>'; els.btnCopy.disabled = true;
    if ($('newClearCtx').checked) { NEW_CLEAR_FIELDS.forEach(k => { $(CTX_FIELDS[k]).value = ''; }); $('fileList').innerHTML = ''; }
    saveCtx();
    els.empty.classList.remove('hidden');
    $('newModal').classList.add('hidden');
    if ($('newClearCtx').checked) { $('infoModal').classList.remove('hidden'); toast('새 회의입니다. 회의 정보를 입력하세요.' + archived, false, 7000); }
    else toast('새 회의를 시작합니다.' + archived, false, 7000);
  } finally { btn.disabled = false; }
};
// ===== 설정 (API 키 · 회사명) =====
async function refreshSettings() {
  try {
    const st = await api('/api/status');
    const ks = $('keyState');
    ks.textContent = st.hasKey ? `사용 중: ${st.keyMasked}` : '아직 없음 — 키를 넣어야 통역할 수 있습니다';
    ks.className = st.hasKey ? 'ok' : 'none';
    $('companyInput').value = st.company || '';
    $('btnKeyDelete').disabled = !st.hasKey;
    return st;
  } catch { $('keyState').textContent = '서버에 연결할 수 없습니다'; }
}
function showKeyModal() {
  $('keyInput').value = ''; $('keyInput').type = 'password'; $('btnKeyShow').textContent = '보기';
  $('keyModal').classList.remove('hidden'); refreshSettings(); setTimeout(() => $('keyInput').focus(), 50);
}
$('btnSettings').onclick = showKeyModal;
$('btnKeyCancel').onclick = () => $('keyModal').classList.add('hidden');
$('keyModal').addEventListener('mousedown', e => { if (e.target.id === 'keyModal') $('keyModal').classList.add('hidden'); });
$('btnKeyShow').onclick = () => { const i = $('keyInput'); i.type = i.type === 'password' ? 'text' : 'password'; $('btnKeyShow').textContent = i.type === 'password' ? '보기' : '숨기기'; };
$('btnKeySave').onclick = async () => {
  const btn = $('btnKeySave'); btn.disabled = true; btn.textContent = $('keyInput').value.trim() ? '키 확인 중...' : '저장 중...';
  try {
    const r = await api('/api/settings', { key: $('keyInput').value, company: $('companyInput').value });
    $('keyModal').classList.add('hidden');
    toast(r.warn ? '저장했습니다. ' + r.warn : (r.hasKey ? '저장했습니다. 통역을 시작할 수 있습니다.' : '저장했습니다.'), !!r.warn, r.warn ? 9000 : 4000);
    if (r.hasKey && S.state === 'idle') setStatus('', '대기');
  } catch (e) { toast(e.message, true, 7000); }
  finally { btn.disabled = false; btn.textContent = '저장'; }
};
$('btnKeyDelete').onclick = async () => {
  if (!confirm('이 컴퓨터에 저장된 OpenAI API 키를 지울까요? 지우면 통역과 번역을 쓸 수 없습니다.')) return;
  try { await api('/api/settings', { deleteKey: true }); await refreshSettings(); toast('API 키를 지웠습니다.'); setStatus('bad', 'API 키 없음'); }
  catch (e) { toast(e.message, true); }
};
$('keyInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnKeySave').click(); });
window.addEventListener('beforeunload', e => { if (S.state === 'live') { e.preventDefault(); e.returnValue = ''; } });

// ===== 회의록 (.docx) =====
function fmtRange(a, b) {
  const W = '일월화수목금토', p = n => String(n).padStart(2, '0');
  return `${a.getFullYear()}년 ${p(a.getMonth() + 1)}월 ${p(a.getDate())}일(${W[a.getDay()]}) ${p(a.getHours())}:${p(a.getMinutes())} ~ ${p(b.getHours())}:${p(b.getMinutes())}`;
}
// 마지막 기록부터 거슬러 올라가 2시간 넘게 끊긴 지점 이전(다른 회의)은 회의록에서 뺀다
function currentMeetingItems() {
  const all = S.items.filter(i => i.src || i.tr);
  let start = all.length - 1;
  while (start > 0 && all[start].at - all[start - 1].at <= NEW_MEETING_GAP_MS) start--;
  return all.slice(Math.max(start, 0));
}
$('btnMinutes').onclick = async () => {
  const items = currentMeetingItems();
  if (!items.length) { toast('아직 통역 기록이 없습니다.', true); return; }
  const nosrc = items.filter(i => i.lang === 'en' && !i.src).length;
  if (nosrc && nosrc / items.length > 0.3) toast(`영어 원문 없는 기록(한국어 발언 추정)이 ${nosrc}건입니다. 회의록 내용을 꼭 검토하세요.`, true, 8000);
  const btn = $('btnMinutes'); btn.disabled = true; btn.textContent = '회의록 작성 중...';
  toast('회의록을 작성하고 있습니다 (30초~1분 정도 걸립니다)', false, 60000);
  try {
    const c = getCtx();
    const r = await fetch('/api/minutes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      items: items.map(i => ({ lang: i.lang, src: i.src, tr: i.tr, status: i.status, time: hhmm(i.at) })),
      context: c,
      meta: { datetime: fmtRange(items[0].at, items[items.length - 1].at), place: c.place, author: c.author },
    }) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + r.status); }
    try { const u = JSON.parse(r.headers.get('X-Usage') || 'null'); if (u) addUsage(u.usage, u.model); } catch {}
    const blob = await r.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = decodeURIComponent(r.headers.get('X-Filename') || '회의록.docx'); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('회의록을 내려받았습니다. 다운로드 폴더를 확인하세요.', false, 6000);
  } catch (e) { toast('회의록 생성 실패: ' + e.message, true, 8000); }
  finally { btn.disabled = false; btn.textContent = '회의록 만들기'; }
};
// gpt-4.1 단가 추가 (회의록용)
TEXT_PRICES['gpt-4.1'] = TEXT_PRICES['gpt-4.1'] || [2.0, 8.0];

// ===== 시작 =====
loadCtx();
updateFileUi();
restoreItems();
listMics();
api('/api/status').then(st => { S.textModel = st.textModel; if (!st.hasKey) showKeyModal(); }).catch(() => setStatus('bad', '서버 꺼짐'));
updateButtons();
