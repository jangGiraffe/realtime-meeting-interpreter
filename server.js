// 실시간 회의 통역 - 로컬 서버 (외부 패키지 없음, Node 18+)
// 역할: OpenAI API 키를 서버에만 보관하고, 브라우저 대신 세션 연결/텍스트 번역을 중계한다.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, '.env');
const PUBLIC = path.join(ROOT, 'public');

function loadEnv() {
  const env = {};
  try {
    const txt = fs.readFileSync(ENV_PATH, 'utf8').replace(/^﻿/, '');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* .env 없음 */ }
  return env;
}
let ENV = loadEnv();
const cfg = (k, d) => process.env[k] || ENV[k] || d;
const apiKey = () => cfg('OPENAI_API_KEY', '');
const PORT = Number(cfg('PORT', 3000));
const REALTIME_MODEL = () => cfg('REALTIME_MODEL', 'gpt-realtime-translate');
const TRANSCRIBE_MODEL = () => cfg('TRANSCRIBE_MODEL', 'gpt-realtime-whisper');
const TEXT_MODEL = () => cfg('TEXT_MODEL', 'gpt-4.1-mini');
const OPENAI = cfg('OPENAI_BASE_URL', 'https://api.openai.com/v1');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function slog(msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] [서버] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(ROOT, 'debug.log'), line + '\n', 'utf8'); } catch {}
}
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function openaiJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || text.slice(0, 300);
    const e = new Error(`OpenAI ${r.status}: ${msg}`); e.status = r.status; throw e;
  }
  return data;
}

// 1) 실시간 번역 세션 연결: 임시 키 발급 → 브라우저 SDP offer를 OpenAI에 전달 → answer 반환
async function rtcConnect(req, res) {
  const { sdp, noise = 'far_field', hint = '' } = JSON.parse(await readBody(req));
  const build = withHint => {
    const transcription = { model: TRANSCRIBE_MODEL() };
    if (withHint && hint) transcription.prompt = String(hint).slice(0, 500); // 고유명사 인식 힌트
    const input = { transcription };
    if (noise === 'near_field' || noise === 'far_field') input.noise_reduction = { type: noise };
    return { model: REALTIME_MODEL(), audio: { input, output: { language: 'ko' } } };
  };
  slog(`세션 요청: noise=${noise}, hint=${hint ? hint.length + '자' : '없음'}`);
  let secret;
  try { secret = await openaiJSON(`${OPENAI}/realtime/translations/client_secrets`, { session: build(true) }); }
  catch (e) {
    // 번역 세션이 인식 힌트(prompt)를 받지 않는 경우 힌트 없이 다시 시도
    if (!hint || !(e.status >= 400 && e.status < 500) || e.status === 401) throw e;
    slog('인식 힌트 거부됨 → 힌트 없이 재시도: ' + e.message);
    secret = await openaiJSON(`${OPENAI}/realtime/translations/client_secrets`, { session: build(false) });
  }
  slog('client_secret 응답 키: ' + Object.keys(secret).join(','));
  const ek = secret.value || (secret.client_secret && secret.client_secret.value);
  if (!ek) throw new Error('임시 키 응답 형식을 알 수 없습니다: ' + JSON.stringify(secret).slice(0, 200));
  const r = await fetch(`${OPENAI}/realtime/translations/calls`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ek}`, 'Content-Type': 'application/sdp' },
    body: sdp,
  });
  const answer = await r.text();
  slog(`calls 응답 ${r.status}, SDP ${answer.length}자`);
  if (!r.ok) throw new Error(`OpenAI 연결 실패 ${r.status}: ${answer.slice(0, 300)}`);
  send(res, 200, { sdp: answer });
}

// 2) 텍스트 번역: refine(영→한 자막 보정), reply(한→영 답변)
function contextBlock(ctx = {}, history = []) {
  const parts = [];
  if (ctx.agenda) parts.push(`[회의 안건]\n${ctx.agenda}`);
  if (ctx.background) parts.push(`[배경 설명]\n${ctx.background}`);
  if (ctx.participants) parts.push(`[참석자]\n${ctx.participants}`);
  if (ctx.glossary) parts.push(`[전문용어·약어 (원어 = 번역/설명)]\n${ctx.glossary}`);
  if (ctx.materials) parts.push(`[회의 자료 브리핑]\n${ctx.materials}`);
  if (history.length) {
    parts.push('[최근 대화 (오래된 순)]\n' + history.map(h => {
      if (h.lang === 'ko') return `- (한국어 발언) ${h.src}`;
      if (h.lang === 'me') return `- (나의 답변) ${h.src} => ${h.tr || ''}`;
      return `- (영어 발언) ${h.src}${h.tr ? ` => ${h.tr}` : ''}`;
    }).join('\n'));
  }
  return parts.join('\n\n') || '(사전 정보 없음)';
}

const RULES = `원칙:
- 사람 이름, 회사·제품명, 숫자, 금액, 날짜, 시간, 단위는 원문 그대로 정확히 유지한다.
- 원문에 없는 사실·주어·숫자를 추가하지 않는다. 추측으로 빈칸을 채우지 않는다.
- 알아듣기 어렵거나 끊긴 부분은 그대로 짧게 두고 필요하면 "(불명확)"으로 표시한다.
- 용어집에 있는 표현은 용어집을 우선한다.
- 설명, 따옴표, 머리말 없이 번역문만 출력한다.`;

async function translate(req, res) {
  const { mode, text, draft, context, history } = JSON.parse(await readBody(req));
  if (!text || !text.trim()) return send(res, 400, { error: 'text 비어 있음' });
  let system, user;
  if (mode === 'reply') {
    system = `당신은 비즈니스 화상회의에서 사용자의 한국어 답변을 영어로 옮기는 통역사다. 회의 문맥에 맞는 자연스럽고 정중한 비즈니스 영어로, 회의 중 그대로 말하거나 채팅에 붙여 넣을 수 있게 번역한다.\n${RULES}`;
    user = `${contextBlock(context, history)}\n\n[번역할 나의 한국어 답변]\n${text}`;
  } else {
    system = `당신은 영어 회의 발언을 한국어 자막으로 옮기는 전문 통역사다. 실시간 엔진의 임시 번역이 함께 주어진다. 영어 원문과 회의 문맥을 기준으로 오역·용어·고유명사만 바로잡아 자연스러운 한국어 자막 한두 문장으로 출력한다. 원문이 잘려 있으면 잘린 만큼만 번역한다. 원문 인식이 없다고 표시되면 임시 번역의 띄어쓰기, 용어집·참석자 이름 표기만 바로잡고 의미는 바꾸지 않는다.\n${RULES}`;
    user = `${contextBlock(context, history)}\n\n[영어 원문 (음성 인식, 오류 가능)]\n${text}\n\n[실시간 임시 번역]\n${draft || '(없음)'}`;
  }
  const data = await openaiJSON(`${OPENAI}/chat/completions`, {
    model: TEXT_MODEL(),
    temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const out = (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
  send(res, 200, { text: out, usage: data.usage || null, model: TEXT_MODEL() });
}

// 3) 회의 자료 텍스트 추출 (docx/xlsx/pptx는 zip+XML을 직접 해석, 외부 패키지 없음)
const zlib = require('zlib');
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 형식이 아닙니다 (암호가 걸린 파일이거나 오래된 .doc/.xls 형식일 수 있음)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    files[name] = () => {
      const ln = buf.readUInt16LE(off + 26), lx = buf.readUInt16LE(off + 28);
      const data = buf.slice(off + 30 + ln + lx, off + 30 + ln + lx + csize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    };
  }
  return files;
}
const xmlDecode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const natSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });

function docxText(z) {
  const xml = z['word/document.xml']();
  return xml.split(/<\/w:p>/).map(p => {
    let t = '';
    p.replace(/<w:tab\/>|<w:br\/>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g, (m, txt) => { t += txt !== undefined ? xmlDecode(txt) : (m.startsWith('<w:tab') ? '\t' : '\n'); return m; });
    return t;
  }).filter(s => s.trim()).join('\n');
}
function xlsxText(z) {
  const shared = [];
  if (z['xl/sharedStrings.xml']) {
    for (const si of z['xl/sharedStrings.xml']().split(/<\/si>/)) {
      let t = ''; si.replace(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g, (m, x) => { t += xmlDecode(x); return m; });
      shared.push(t);
    }
  }
  const names = [];
  if (z['xl/workbook.xml']) z['xl/workbook.xml']().replace(/<sheet\s[^>]*name="([^"]*)"/g, (m, n) => { names.push(xmlDecode(n)); return m; });
  const sheets = Object.keys(z).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort(natSort);
  const out = [];
  sheets.forEach((k, i) => {
    out.push(`## 시트: ${names[i] || k}`);
    for (const row of z[k]().split(/<\/row>/)) {
      const cells = [];
      row.replace(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m, attrs, inner = '') => {
        const type = (attrs.match(/t="([^"]+)"/) || [])[1];
        let v = (inner.match(/<v>([^<]*)<\/v>/) || [])[1];
        if (type === 's' && v !== undefined) v = shared[+v];
        else if (type === 'inlineStr') { v = ''; inner.replace(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g, (mm, x) => { v += x; return mm; }); v = xmlDecode(v); }
        else if (v !== undefined) { v = xmlDecode(v); if (!type && /^-?\d+\.\d{6,}$/.test(v)) v = String(parseFloat(Number(v).toPrecision(12))); }
        if (v !== undefined && String(v).trim() !== '') cells.push(String(v).trim());
        return m;
      });
      if (cells.length) out.push(cells.join(' | '));
    }
  });
  return out.join('\n');
}
function pptxText(z) {
  return Object.keys(z).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort(natSort).map((k, i) => {
    const paras = z[k]().split(/<\/a:p>/).map(p => { let t = ''; p.replace(/<a:t>([^<]*)<\/a:t>/g, (m, x) => { t += xmlDecode(x); return m; }); return t; }).filter(s => s.trim());
    return `## 슬라이드 ${i + 1}\n${paras.join('\n')}`;
  }).join('\n');
}
function decodeText(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  const s = buf.toString('utf8');
  if (!s.includes('�')) return s;
  try { return new TextDecoder('euc-kr').decode(buf); } catch { return s; } // 윈도우 메모장 ANSI(CP949) 대응
}
function extractText(name, buf) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.docx') return docxText(unzip(buf));
  if (ext === '.xlsx' || ext === '.xlsm') return xlsxText(unzip(buf));
  if (ext === '.pptx') return pptxText(unzip(buf));
  if (['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.vtt', '.srt'].includes(ext)) return decodeText(buf);
  if (ext === '.doc' || ext === '.xls' || ext === '.ppt') throw new Error('구형 Office 형식입니다. 다른 이름으로 저장 → .docx/.xlsx/.pptx로 바꿔 올려주세요.');
  throw new Error('지원하지 않는 형식: ' + ext);
}
async function extract(req, res) {
  const { name, data } = JSON.parse(await readBody(req));
  const text = extractText(name, Buffer.from(data, 'base64')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  send(res, 200, { text, chars: text.length });
}
// 자료 → 통역용 브리핑 요약 (매 문장 번역 호출에 원문 전체를 싣지 않도록 압축)
async function digest(req, res) {
  const { name, text } = JSON.parse(await readBody(req));
  const MAX = 60000;
  const body = text.length > MAX ? text.slice(0, MAX) + '\n...(이하 생략)' : text;
  const data = await openaiJSON(`${OPENAI}/chat/completions`, {
    model: TEXT_MODEL(),
    temperature: 0.1,
    messages: [
      { role: 'system', content: `회의 통역사를 위한 사전 브리핑을 만든다. 주어진 회의 자료에서 통역에 필요한 정보만 뽑아 한국어로 간결하게 정리한다. 자료에 없는 내용은 절대 만들지 않는다. 형식:
[요지] 2~4줄
[인물·조직] 이름(영문 표기 그대로) - 소속/역할
[용어·약어] 영어 원어 = 한국어 번역/설명 (자료에 나온 것만)
[핵심 숫자·날짜] 금액, 수량, 일정 등 원문 그대로
[논의 포인트] 예상 쟁점 몇 줄
전체 1500자 이내.` },
      { role: 'user', content: `파일명: ${name}\n\n${body}` },
    ],
  });
  const out = (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
  send(res, 200, { text: out, usage: data.usage || null, model: TEXT_MODEL() });
}

// 4) 회의록 생성
const minutes = require('./minutes');
const MINUTES_MODEL = () => cfg('MINUTES_MODEL', 'gpt-4.1');
async function makeMinutes(req, res) {
  const { items, context = {}, meta = {} } = JSON.parse(await readBody(req));
  if (!items || !items.length) return send(res, 400, { error: '통역 기록이 없습니다.' });
  const ctx = [
    context.title && `회의 제목: ${context.title}`, context.agenda && `안건:\n${context.agenda}`,
    context.background && `배경:\n${context.background}`, context.participants && `참석자:\n${context.participants}`,
    context.glossary && `용어:\n${context.glossary}`, context.materials && `자료 브리핑:\n${context.materials}`,
  ].filter(Boolean).join('\n\n');
  const data = await openaiJSON(`${OPENAI}/chat/completions`, {
    model: MINUTES_MODEL(), temperature: 0.2, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: minutes.systemPrompt(cfg('COMPANY_NAME', '')) },
      { role: 'user', content: `[회의 사전 정보]\n${ctx || '(없음)'}\n\n[통역 기록]\n${minutes.transcriptText(items)}` },
    ],
  });
  let d; try { d = JSON.parse(data.choices[0].message.content); } catch { throw new Error('회의록 내용 생성 결과를 해석하지 못했습니다.'); }
  d.title = context.title || d.title || '';
  d.datetime = meta.datetime || '';
  d.place = meta.place || '';
  d.author = meta.author || cfg('COMPANY_NAME', '');
  const tplPath = path.join(ROOT, 'templates', '회의록양식.docx');
  const docx = minutes.fillTemplate(fs.readFileSync(tplPath), d);
  const fname = `회의록_${(d.title || '회의').replace(/[\\/:*?"<>|]/g, '_')}_${new Date().toISOString().slice(0, 10)}.docx`;
  try { // 프로그램 폴더의 '회의록' 폴더에도 사본 저장
    fs.mkdirSync(path.join(ROOT, '회의록'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, '회의록', fname), docx);
  } catch (e) { slog('회의록 사본 저장 실패: ' + e.message); }
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    'X-Usage': JSON.stringify({ usage: data.usage || null, model: MINUTES_MODEL() }),
    'X-Filename': encodeURIComponent(fname),
  });
  res.end(docx);
  slog(`회의록 생성: ${fname} (${items.length}개 기록)`);
}

// 5) 새 회의 시작 전 기록 보관 → 프로그램 폴더의 '기록' 폴더
async function archive(req, res) {
  const { title = '회의', text = '' } = JSON.parse(await readBody(req));
  if (!text.trim()) return send(res, 400, { error: '보관할 기록이 없습니다.' });
  const p2 = n => String(n).padStart(2, '0'), d = new Date();
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const file = `통역기록_${stamp}_${String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.txt`;
  fs.mkdirSync(path.join(ROOT, '기록'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '기록', file), '\uFEFF' + text, 'utf8');
  slog('기록 보관: ' + file);
  send(res, 200, { ok: true, file });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return send(res, 200, { hasKey: !!apiKey(), realtimeModel: REALTIME_MODEL(), textModel: TEXT_MODEL() });
    }
    if (url.pathname === '/api/key' && req.method === 'POST') {
      const { key } = JSON.parse(await readBody(req));
      if (!key || !/^sk-/.test(key.trim())) return send(res, 400, { error: 'sk- 로 시작하는 키를 입력하세요' });
      let txt = ''; try { txt = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}
      txt = /^OPENAI_API_KEY=.*$/m.test(txt) ? txt.replace(/^OPENAI_API_KEY=.*$/m, `OPENAI_API_KEY=${key.trim()}`) : `OPENAI_API_KEY=${key.trim()}\n${txt}`;
      fs.writeFileSync(ENV_PATH, txt, 'utf8');
      ENV = loadEnv();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/extract' && req.method === 'POST') return await extract(req, res);
    if (url.pathname === '/api/log' && req.method === 'POST') {
      const { lines } = JSON.parse(await readBody(req));
      fs.appendFileSync(path.join(ROOT, 'debug.log'), (lines || []).join('\n') + '\n', 'utf8');
      return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/') && !apiKey()) return send(res, 401, { error: 'OpenAI API 키가 설정되지 않았습니다.' });
    if (url.pathname === '/api/rtc' && req.method === 'POST') return await rtcConnect(req, res);
    if (url.pathname === '/api/translate' && req.method === 'POST') return await translate(req, res);
    if (url.pathname === '/api/digest' && req.method === 'POST') return await digest(req, res);
    if (url.pathname === '/api/minutes' && req.method === 'POST') return await makeMinutes(req, res);
    if (url.pathname === '/api/archive' && req.method === 'POST') return await archive(req, res);

    // 정적 파일
    let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  } catch (e) {
    slog('[오류] ' + req.url + ' ' + e.message);
    send(res, e.status && e.status < 500 ? e.status : 500, { error: e.message });
  }
}

// server.js가 바뀌면 스스로 종료 → start.bat이 자동으로 다시 실행
// 폴더 단위로 감시 (파일을 교체 저장해도 감지되도록)
let restarting = false;
fs.watch(ROOT, (ev, f) => {
  if (restarting || !f || !/^(server|minutes)\.js$/.test(String(f))) return;
  restarting = true; slog(f + ' 변경 감지 → 재시작'); setTimeout(() => process.exit(0), 500);
});

http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log('==============================================');
  console.log(' 실시간 회의 통역 실행 중');
  console.log(` 브라우저(Chrome/Edge)에서 열기: http://localhost:${PORT}`);
  console.log(` API 키: ${apiKey() ? '설정됨' : '미설정 (화면에서 입력 가능)'}`);
  console.log(' 종료: 이 창에서 Ctrl+C');
  console.log('==============================================');
  if (process.platform === 'win32' && !process.env.NO_BROWSER && !process.env.RESTARTED) require('child_process').exec(`start "" http://localhost:${PORT}`);
});
