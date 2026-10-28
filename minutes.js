// 회의록 생성: 통역 기록 → (LLM) 구조화 JSON → 회사 회의록 양식(docx)에 채워 넣기
// 외부 패키지 없이 zip을 직접 읽고 쓴다.
'use strict';
const zlib = require('zlib');

// ---------- zip 읽기/쓰기 ----------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('docx(zip) 형식이 아닙니다');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    const ln = buf.readUInt16LE(off + 26), lx = buf.readUInt16LE(off + 28);
    const raw = buf.slice(off + 30 + ln + lx, off + 30 + ln + lx + csize);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
  }
  return out;
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function writeZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8'), comp = zlib.deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp); centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- docx XML 조작 ----------
const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function blocks(xml, tag) { // 최상위 레벨 <tag>...</tag> 위치들 (중첩 고려)
  const res = []; const open = new RegExp(`<${tag}[ >]|</${tag}>`, 'g'); let depth = 0, start = -1, m;
  while ((m = open.exec(xml))) {
    if (m[0].startsWith('</')) { depth--; if (depth === 0) res.push([start, m.index + m[0].length]); }
    else { if (depth === 0) start = m.index; depth++; }
  }
  return res;
}
const parts = (xml, tag) => blocks(xml, tag).map(([a, b]) => xml.slice(a, b));
function replaceBlocks(xml, tag, fn) { // fn(blockXml, index) → 새 xml
  const bs = blocks(xml, tag); let out = '', last = 0;
  bs.forEach(([a, b], i) => { out += xml.slice(last, a) + fn(xml.slice(a, b), i); last = b; });
  return out + xml.slice(last);
}
const pPrOf = p => (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
function rPrOf(p) {
  const run = p.match(/<w:r[ >][\s\S]*?<\/w:r>/);
  const r = run && run[0].match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  if (r) return r[0];
  const markR = pPrOf(p).match(/<w:rPr>[\s\S]*?<\/w:rPr>/); // 문단 기호 서식을 글자 서식으로 사용
  return markR ? markR[0] : '';
}
const para = (pPr, rPr, text, prefix = '') => `<w:p>${pPr}${prefix}<w:r>${rPr}<w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`;
function setCellLines(tc, lines) {
  const ps = parts(tc, 'w:p'); const proto = ps[0] || '<w:p/>';
  const pPr = pPrOf(proto), rPr = rPrOf(proto);
  const body = (lines.length ? lines : ['']).map(t => para(pPr, rPr, t)).join('');
  const tcPr = (tc.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0];
  return `<w:tc>${tcPr}${body}</w:tc>`;
}
const cellText = tc => parts(tc, 'w:p').map(p => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')).join('\n');

function fillTemplate(tplBuf, d) {
  const files = readZip(tplBuf);
  const doc = files.find(f => f.name === 'word/document.xml');
  let xml = doc.data.toString('utf8');
  const [tA, tB] = blocks(xml, 'w:tbl')[0];
  let tbl = xml.slice(tA, tB);
  const rows = parts(tbl, 'w:tr');
  const label = r => cellText(parts(r, 'w:tc')[0] || '').replace(/\s/g, '');
  const setRow = (r, map) => replaceBlocks(r, 'w:tc', (tc, i) => (i in map ? setCellLines(tc, map[i]) : tc));
  const L = v => (Array.isArray(v) ? v : (v ? [v] : [])).filter(x => x !== undefined && x !== null).map(String);

  let actionProto = null; const actionIdx = [];
  const newRows = rows.map((r, i) => {
    const lb = label(r);
    if (lb === '회의명') return setRow(r, { 1: L(d.title) });
    if (lb === '일시') return setRow(r, { 1: L(d.datetime), 3: L(d.place) });
    if (lb === '참석자') return setRow(r, { 1: L(d.attendees) });
    if (lb === '작성자') return setRow(r, { 1: L(d.author) });
    if (lb === '주요Agenda') return setRow(r, { 1: L(d.agenda).map((a, k) => `${k + 1}. ${a}`) });
    if (lb === '합의사항') return setRow(r, { 1: L(d.agreements).map(a => `- ${a}`) });
    if (lb === '미결사항') return setRow(r, { 1: L(d.pending).map(a => `- ${a}`) });
    if (lb === '기타') return setRow(r, { 1: L(d.etc).map(a => `- ${a}`) });
    // 회의 내용 본문: 번호 제목 / 글머리 / → 하위 서식을 원본 문단에서 복제
    const tcs = parts(r, 'w:tc');
    if (tcs.length === 1 && /Bulletpoint11/.test(r)) {
      const ps = parts(tcs[0], 'w:p');
      const pH = ps.find(p => /Bulletpoint11/.test(p)) || ps[0];
      const pB = ps.find(p => /Bulletpoint12/.test(p) && !/w:sym/.test(p)) || pH;
      const pA = ps.find(p => /w:sym/.test(p)) || pB;
      const sym = (pA.match(/<w:r[ >](?:(?!<\/w:r>)[\s\S])*?<w:sym[^>]*\/>[\s\S]*?<\/w:r>/) || [''])[0];
      const out = [];
      for (const s of d.sections || []) {
        out.push(para(pPrOf(pH), rPrOf(pH), s.title || ''));
        for (const pt of s.points || []) {
          const text = typeof pt === 'string' ? pt : pt.text;
          out.push(para(pPrOf(pB), rPrOf(pB), text || ''));
          for (const sub of (pt && pt.subs) || []) out.push(para(pPrOf(pA), rPrOf(pA), ' ' + sub, sym));
        }
      }
      out.push(ps[ps.length - 1]); // 마지막 빈 문단(여백) 유지
      const tcPr = (tcs[0].match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0];
      return replaceBlocks(r, 'w:tc', () => `<w:tc>${tcPr}${out.join('')}</w:tc>`);
    }
    // Action Item 데이터 행 (헤더 다음 행들)
    const hdr = rows.findIndex(x => /상세내용/.test(cellText(x)));
    if (hdr >= 0 && i > hdr && tcs.length >= 5) {
      if (!actionProto) actionProto = r;
      actionIdx.push(i);
      return null;
    }
    return r;
  });
  // Action Item 행 재구성 (최소 3행 유지)
  const acts = (d.actions || []).slice();
  while (acts.length < 3) acts.push({});
  const actionRows = acts.map(a => setRow(actionProto || '', { 1: L(a.item), 2: L(a.detail), 3: L(a.owner), 4: L(a.due) }));
  const firstAction = actionIdx.length ? actionIdx[0] : newRows.length;
  const finalRows = [];
  newRows.forEach((r, i) => { if (i === firstAction) finalRows.push(...actionRows); if (r !== null) finalRows.push(r); });
  if (firstAction >= newRows.length && actionProto) finalRows.push(...actionRows);
  // 표 재조립
  const head = tbl.slice(0, blocks(tbl, 'w:tr')[0][0]);
  tbl = head + finalRows.join('') + '</w:tbl>';
  xml = xml.slice(0, tA) + tbl + xml.slice(tB);
  doc.data = Buffer.from(xml, 'utf8');
  return writeZip(files);
}

// ---------- LLM: 기록 → 회의록 JSON ----------
const SYSTEM_BODY = `__COMPANY__의 회의록 작성자다. 통역 기록(영어 원문, 한국어 번역, 한국어 발언, 내 답변)을 읽고 회사 회의록 양식에 들어갈 내용을 JSON으로 만든다.
작성 규칙:
- 한국어 개조식 문체로 짧게 쓴다 (예: "~ 수행됨", "~ 예정", "~ 필요", "~ 확인함").
- 기록과 사전 정보에 있는 내용만 쓴다. 추측으로 담당자·날짜·숫자를 만들지 않는다. 모르면 빈 문자열.
- 이름, 회사·시스템명, 숫자, 날짜, 금액은 원문 그대로 정확히 쓴다. 영어 고유명사는 영어 표기 유지.
- 회의 내용(sections)은 주제별로 묶고, 각 주제는 핵심 포인트 2~6개, 필요하면 포인트 아래 세부(subs)를 단다.
- 합의사항은 실제로 합의·결정된 것만, 미결사항은 결론이 안 난 것·추가 확인 필요한 것.
- Action Item은 누가 무엇을 하기로 한 것. 담당자·기한은 기록에 있을 때만.
- "한국어 발언 추정" 기록은 영어 원문 없이 번역 엔진이 낸 한국어 문장이다. 대부분 우리 측 한국어 발언이지만 영어 발언의 원문이 빠진 것일 수도 있다. 앞뒤 흐름에 맞으면 한국어 발언처럼 반영하되, 이것만 근거로 숫자·합의사항·Action Item을 만들지 않는다.
- 영어 원문과 번역이 다르면 영어 원문을 기준으로 쓴다.
- 한국어 발언(우리 측 의견·질문·결정)도 영어 발언과 똑같이 회의 내용, 합의사항, 미결사항, Action Item에 반영한다.
- 참석자는 "회사명: 이름, 이름" 형식 줄 배열. 사전 정보와 기록에 나온 사람만.
출력 JSON 스키마:
{"title":"","attendees":[""],"agenda":[""],"sections":[{"title":"","points":[{"text":"","subs":[""]}]}],"agreements":[""],"pending":[""],"etc":[""],"actions":[{"item":"","detail":"","owner":"","due":""}]}`;

function transcriptText(items) {
  return (items || []).map(it => {
    const t = it.time || '';
    if (it.lang === 'ko') return `[${t}] (한국어 발언) ${it.src}`;
    if (it.lang === 'me') return `[${t}] (나의 답변, 한국어) ${it.src} / (영어로 전달) ${it.tr}`;
    if (!it.src) return `[${t}] (한국어 발언 추정 · 영어 원문 없음) ${it.tr || ''}`;
    return `[${t}] (영어 발언) ${it.src} / (번역) ${it.tr || ''}`;
  }).join('\n');
}

// 회사명은 .env의 COMPANY_NAME (없으면 일반 표현)
const systemPrompt = company => '당신은 ' + SYSTEM_BODY.replace('__COMPANY__', company ? `IT 회사(${company})` : 'IT 회사');
module.exports = { fillTemplate, systemPrompt, transcriptText, readZip };
