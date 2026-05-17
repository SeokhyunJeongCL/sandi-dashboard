#!/usr/bin/env node
/**
 * SA2025 기획자 HTML 대시보드 생성기
 * 실행: node jira-dashboard.mjs [--open]
 * 출력: docs/index.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── 환경설정 ──────────────────────────────────────────
function loadEnv() {
  if (process.env.JIRA_BASE_URL) return process.env;
  return Object.fromEntries(
    readFileSync(join(__dir, '.env'), 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
      .filter(([k]) => k)
  );
}
const env  = loadEnv();
const BASE = env.JIRA_BASE_URL;
const AUTH = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
const PROJ = env.JIRA_PROJECT;
const JSJH = '712020:874a2d08-213b-4b2c-b135-8dca714fc604';
const HDR  = { Authorization: `Basic ${AUTH}`, 'Content-Type': 'application/json' };

// ── Jira API ──────────────────────────────────────────
async function jqlAll(jql, fields, limit = 2000) {
  const all = []; let next = null;
  do {
    const body = { jql, fields, maxResults: Math.min(100, limit - all.length) };
    if (next) body.nextPageToken = next;
    const r = await fetch(`${BASE}/rest/api/3/search/jql`, { method: 'POST', headers: HDR, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Jira ${r.status}`);
    const d = await r.json();
    all.push(...(d.issues || []));
    next = d.isLast ? null : d.nextPageToken;
  } while (next && all.length < limit);
  return all;
}

async function getComments(key) {
  const r = await fetch(`${BASE}/rest/api/3/issue/${key}/comment?maxResults=50`, { headers: HDR });
  return r.ok ? ((await r.json()).comments || []) : [];
}

// ── 분류기 ────────────────────────────────────────────
const THEMES = [
  { name: '공간예약/회의실', keys: ['공간', '예약', '회의실', 'm365', '팀즈', '캘린더', '장기 예약', '당일 예약'] },
  { name: '결제',           keys: ['결제', '환불', '유료'] },
  { name: '출입카드',        keys: ['출입카드', '카드번호', '방재실'] },
  { name: '방문자',          keys: ['방문자', '방문 관리', '방문완료', '스피드게이트'] },
  { name: '비상대피',        keys: ['비상대피', '대피', 'gps'] },
  { name: '로그인/인증/보안', keys: ['로그인', 'jwt', '보안', 'isms', '토큰', '잠금'] },
  { name: 'GS/외부연동',    keys: ['gs', '아워홈', '쿠팡', '사원카드', '온습도'] },
  { name: '로그/인프라/배포', keys: ['로그', 'cdk', '배포', '에이전트', 'flyway', '인스턴스', 'sonar', 'sentry', 'cloudwatch', 'quota'] },
  { name: 'UI/디자인',      keys: ['tailwind', '디자인 시스템', 'ui', '스크롤', '플로팅', '배너', '문구'] },
  { name: 'QR/출입',        keys: ['qr', '출입'] },
  { name: 'Push/알림',      keys: ['push', '알림'] },
];
const T_SIG = ['[fo]','[bo]','화면','버튼','스크롤','목록','조회','상세','신청','승인','반려','배너','알림','예약 완료','완료 화면','노출','표시','문구','로그인','잠금','push','출입카드'];
const D_SIG = ['cdk','flyway','sonarqube','배포라인','에이전트 코드','인스턴스','cloudwatch','로그 제거','로그 운영','코드 정리','quota','sentry','환경 설정','헤더 응답','제니퍼','elb','awselb','countStatus','webclient','http 헤더','폴링 반복'];

const themeOf    = s => { const l = s.toLowerCase(); for (const t of THEMES) if (t.keys.some(k => l.includes(k))) return t.name; return '기타'; };
const testableOf = s => { const l = s.toLowerCase(); if (D_SIG.some(k => l.includes(k))) return 'dev'; if (T_SIG.some(k => l.includes(k)) || /^\[(bo|fo)\]/i.test(s.trim())) return 'qa'; return 'unclear'; };

// ── 2주 기간 목록 (2026-01-01 ~ 현재) ────────────────
function buildPeriods() {
  const now = new Date(); let d = new Date('2026-01-01'); const list = [];
  while (d <= now) {
    const e = new Date(d); e.setDate(d.getDate() + 13);
    if (e > now) e.setTime(now.getTime());
    list.push({ label: `${d.getMonth()+1}/${d.getDate()}`, start: d.toISOString().slice(0,10), end: e.toISOString().slice(0,10) });
    d.setDate(d.getDate() + 14);
  }
  return list;
}

// ── QA 완료 여부 ──────────────────────────────────────
async function myQAStatus(key, pct) {
  if (pct >= 100) return { done: true, note: '전체완료' };
  const cmts = await getComments(key);
  const mine = cmts.filter(c => c.author?.accountId === JSJH).sort((a,b) => b.created > a.created ? 1 : -1)[0];
  if (mine) return { done: true, note: `댓글 ${mine.created.slice(0,10)}` };
  return { done: false, note: pct === 0 ? '미시작' : '댓글없음' };
}

// ── 메인 ──────────────────────────────────────────────
async function main() {
  const now = new Date();
  console.log('데이터 수집 중...');

  const [allIssues, qaIssues] = await Promise.all([
    jqlAll(`project=${PROJ} AND created >= "2026-01-01" ORDER BY created ASC`,
      ['summary','status','issuetype','created','updated','assignee','priority'], 2000),
    jqlAll(`project=${PROJ} AND status=QA ORDER BY priority ASC, updated ASC`,
      ['summary','status','assignee','priority','created','updated','customfield_10115'], 200),
  ]);
  console.log(`  이슈: ${allIssues.length}건 | QA: ${qaIssues.length}건`);

  console.log('QA 댓글 확인 중...');
  const qaMap = Object.fromEntries(
    await Promise.all(qaIssues.map(async i => [i.key, await myQAStatus(i.key, i.fields.customfield_10115 ?? 0)]))
  );

  // ── 처리 ────────────────────────────────────────────
  const periods = buildPeriods();
  const isDone  = i => i.fields.status?.statusCategory?.key === 'done';
  const isBug   = i => (i.fields.issuetype?.name || '').includes('버그');
  const inRange = (date, p) => date >= p.start && date <= p.end;

  // 벨로시티 & 번업
  let cumC = 0, cumD = 0;
  const velocityData = periods.map(p => {
    const c = allIssues.filter(i => inRange((i.fields.created||'').slice(0,10), p)).length;
    const d = allIssues.filter(i => isDone(i) && inRange((i.fields.updated||'').slice(0,10), p)).length;
    cumC += c; cumD += d;
    return { label: p.label, created: c, completed: d, cumCreated: cumC, cumCompleted: cumD };
  });

  // 버그 vs 기능
  const bugVsFeature = periods.map(p => {
    const done = allIssues.filter(i => isDone(i) && inRange((i.fields.updated||'').slice(0,10), p));
    return { label: p.label, bugs: done.filter(isBug).length, features: done.filter(i => !isBug(i)).length };
  });

  // 상태 스냅샷
  const statusSnap = {};
  for (const i of allIssues) {
    const s = i.fields.status?.name || '기타';
    statusSnap[s] = (statusSnap[s]||0) + 1;
  }

  // 주제별 (활성 이슈)
  const themeSnap = {};
  for (const i of allIssues.filter(i => !isDone(i))) {
    const t = themeOf(i.fields.summary), s = i.fields.status?.name || '기타';
    if (!themeSnap[t]) themeSnap[t] = {};
    themeSnap[t][s] = (themeSnap[t][s]||0) + 1;
  }

  // QA 체류 기간
  const BINS = ['0-3일','4-7일','8-14일','15일+'];
  const ageBin = d => d <= 3 ? '0-3일' : d <= 7 ? '4-7일' : d <= 14 ? '8-14일' : '15일+';
  const qaAge  = { qa: {}, unclear: {}, dev: {} };
  for (const i of qaIssues) {
    const t   = testableOf(i.fields.summary);
    const bin = ageBin(Math.round((now - new Date(i.fields.updated)) / 86400000));
    if (!qaAge[t][bin]) qaAge[t][bin] = 0;
    qaAge[t][bin]++;
  }

  // 담당자별 부하
  const assigneeLoad = {};
  for (const i of allIssues.filter(i => !isDone(i))) {
    const a = i.fields.assignee?.displayName || '미배정';
    assigneeLoad[a] = (assigneeLoad[a]||0) + 1;
  }

  // QA 테이블
  const qaTable = qaIssues.map(i => {
    const st = qaMap[i.key] || { done: false, note: '?' };
    return {
      key:      i.key,
      summary:  i.fields.summary,
      assignee: i.fields.assignee?.displayName || '미배정',
      priority: i.fields.priority?.name || '-',
      ageDays:  Math.round((now - new Date(i.fields.updated)) / 86400000),
      type:     testableOf(i.fields.summary),
      myDone:   st.done,
      myNote:   st.note,
    };
  });

  const summary = {
    total:    allIssues.length,
    active:   allIssues.filter(i => !isDone(i)).length,
    done:     allIssues.filter(i => isDone(i)).length,
    inQA:     qaIssues.length,
    myTodo:   qaTable.filter(r => r.type === 'qa' && !r.myDone).length,
    myDone:   qaTable.filter(r => r.type === 'qa' && r.myDone).length,
  };

  const dashData = { generatedAt: now.toISOString(), summary, velocityData, bugVsFeature, statusSnap, themeSnap, qaAge, assigneeLoad, qaTable, bins: BINS };

  mkdirSync(join(__dir, 'docs'), { recursive: true });
  const out = join(__dir, 'docs', 'index.html');
  writeFileSync(out, buildHTML(dashData, BASE), 'utf8');
  console.log('완료:', out);

  if (process.argv.includes('--open')) {
    try { execSync(`start "" "${out}"`); } catch {}
  }
}

// ── HTML 빌더 ─────────────────────────────────────────
function buildHTML(data, baseUrl) {
  // </script 가 HTML을 깨지 않도록 이스케이프
  const json = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
  const baseJson = JSON.stringify(baseUrl);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SA2025 기획자 대시보드</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Pretendard,sans-serif;background:#F4F5F7;color:#172B4D;font-size:14px}
.hd{background:#0052CC;color:#fff;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.hd h1{font-size:17px;font-weight:700;letter-spacing:-.3px}
.hd time{font-size:11px;opacity:.75}
.wrap{max-width:1440px;margin:0 auto;padding:16px;display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.card{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.card h2{font-size:11px;font-weight:700;color:#5E6C84;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px}
.span2{grid-column:span 2}.span4{grid-column:span 4}
/* KPI */
.kpi-wrap{grid-column:span 4;display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.kpi{background:#fff;border-radius:10px;padding:12px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.kpi .v{font-size:30px;font-weight:800;color:#0052CC;line-height:1}
.kpi .l{font-size:11px;color:#5E6C84;margin-top:4px}
.kpi.warn .v{color:#FF5630}.kpi.ok .v{color:#36B37E}.kpi.purple .v{color:#6554C0}
/* Chart height */
.ch{position:relative;height:240px}
.ch-tall{position:relative;height:300px}
/* Table */
.qa-filters{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.qa-filters button{padding:5px 14px;border:1.5px solid #DFE1E6;border-radius:20px;background:#fff;cursor:pointer;font-size:12px;color:#5E6C84;transition:all .15s}
.qa-filters button.on{background:#0052CC;color:#fff;border-color:#0052CC}
table{width:100%;border-collapse:collapse;font-size:12px}
th{padding:7px 8px;border-bottom:2px solid #DFE1E6;color:#5E6C84;font-weight:700;text-align:left;white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid #F4F5F7;vertical-align:middle}
tr:hover td{background:#F8F9FA}
.tag{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.t-done{background:#E3FCEF;color:#006644}
.t-todo{background:#FFFAE6;color:#974F0C}
.t-dev{background:#F4F5F7;color:#5E6C84}
.t-fo{background:#DEEBFF;color:#0747A6}
.t-unc{background:#F3F0FF;color:#403294}
.p-hi{background:#FFEBE6;color:#BF2600}
.p-h{background:#FFF0E0;color:#974F0C}
.p-m{background:#FFFAE6;color:#974F0C}
.p-l{background:#F4F5F7;color:#5E6C84}
.aw{color:#FF5630;font-weight:700}
a.jl{color:#0052CC;text-decoration:none;font-weight:600}
a.jl:hover{text-decoration:underline}
.empty{color:#97A0AF;font-style:italic;padding:12px 8px}
</style>
</head>
<body>
<div class="hd">
  <h1>SA2025 기획자 대시보드</h1>
  <time id="ts"></time>
</div>
<div class="wrap">
  <!-- KPI -->
  <div class="kpi-wrap">
    <div class="kpi"><div class="v" id="k0"></div><div class="l">전체 이슈</div></div>
    <div class="kpi purple"><div class="v" id="k1"></div><div class="l">활성 이슈</div></div>
    <div class="kpi ok"><div class="v" id="k2"></div><div class="l">완료</div></div>
    <div class="kpi"><div class="v" id="k3"></div><div class="l">QA 대기</div></div>
    <div class="kpi warn"><div class="v" id="k4"></div><div class="l">내 미완료 QA</div></div>
    <div class="kpi ok"><div class="v" id="k5"></div><div class="l">내 완료 QA</div></div>
  </div>

  <!-- 번업 + 벨로시티 (full) -->
  <div class="card span4">
    <h2>벨로시티 &amp; 번업 (2주 단위 · 2026-01-01~현재)</h2>
    <div class="ch-tall"><canvas id="c0"></canvas></div>
  </div>

  <!-- 상태 도넛 -->
  <div class="card span2">
    <h2>현재 상태 분포</h2>
    <div class="ch"><canvas id="c1"></canvas></div>
  </div>

  <!-- 담당자 부하 -->
  <div class="card span2">
    <h2>담당자별 활성 티켓</h2>
    <div class="ch"><canvas id="c2"></canvas></div>
  </div>

  <!-- 버그 vs 기능 -->
  <div class="card span2">
    <h2>버그 vs 기능 — 완료 추이</h2>
    <div class="ch"><canvas id="c3"></canvas></div>
  </div>

  <!-- QA 체류 기간 -->
  <div class="card span2">
    <h2>QA 체류 기간 분포</h2>
    <div class="ch"><canvas id="c4"></canvas></div>
  </div>

  <!-- 주제별 -->
  <div class="card span4">
    <h2>주제별 현황 (활성 이슈)</h2>
    <div class="ch-tall"><canvas id="c5"></canvas></div>
  </div>

  <!-- QA 테이블 -->
  <div class="card span4">
    <h2>QA 버킷 상세</h2>
    <div class="qa-filters">
      <button class="on" onclick="fqa('all',this)">전체 <span id="cnt-all"></span></button>
      <button onclick="fqa('mytodo',this)">⬜ 내 미완료 <span id="cnt-mytodo"></span></button>
      <button onclick="fqa('mydone',this)">✅ 내 완료 <span id="cnt-mydone"></span></button>
      <button onclick="fqa('dev',this)">개발자전용 <span id="cnt-dev"></span></button>
    </div>
    <table><thead><tr>
      <th>키</th><th>제목</th><th>담당자</th><th>우선순위</th><th>체류</th><th>유형</th><th>내 상태</th>
    </tr></thead><tbody id="qtb"></tbody></table>
  </div>
</div>

<script>
const D = ${json};
const JIRA = ${baseJson};

// ── KPI ──────────────────────────────────────────────
document.getElementById('ts').textContent = '업데이트: ' + new Date(D.generatedAt).toLocaleString('ko-KR');
['k0','k1','k2','k3','k4','k5'].forEach((id,i) => {
  document.getElementById(id).textContent = [D.summary.total,D.summary.active,D.summary.done,D.summary.inQA,D.summary.myTodo,D.summary.myDone][i];
});

// ── 팔레트 ────────────────────────────────────────────
const P = ['#0052CC','#36B37E','#FF5630','#FFAB00','#6554C0','#00B8D9','#FF8B00','#97A0AF'];
const alpha = (c,a) => c + Math.round(a*255).toString(16).padStart(2,'0');

// ── 차트 공통 옵션 ─────────────────────────────────────
Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
Chart.defaults.font.size   = 11;

// 0. 벨로시티 + 번업
{
  const vd = D.velocityData;
  new Chart('c0', {
    type: 'bar',
    data: {
      labels: vd.map(p => p.label),
      datasets: [
        { type:'bar',  label:'완료/2주',  data: vd.map(p => p.completed), backgroundColor: alpha('#0052CC',0.3), borderColor:'#0052CC', borderWidth:1, yAxisID:'y' },
        { type:'bar',  label:'생성/2주',  data: vd.map(p => p.created),   backgroundColor: alpha('#FF8B00',0.25),borderColor:'#FF8B00', borderWidth:1, yAxisID:'y' },
        { type:'line', label:'누적 생성', data: vd.map(p => p.cumCreated),   borderColor:'#FF8B00', backgroundColor:'transparent', borderWidth:2, pointRadius:3, tension:.3, yAxisID:'y2' },
        { type:'line', label:'누적 완료', data: vd.map(p => p.cumCompleted), borderColor:'#36B37E', backgroundColor:'transparent', borderWidth:2, pointRadius:3, tension:.3, yAxisID:'y2' },
      ],
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:'top', labels:{ boxWidth:12, padding:12 } } },
      scales:{
        y:  { type:'linear', position:'left',  title:{ display:true, text:'건/2주' }, beginAtZero:true },
        y2: { type:'linear', position:'right', title:{ display:true, text:'누적' }, beginAtZero:true, grid:{ drawOnChartArea:false } },
      },
    },
  });
}

// 1. 상태 도넛
{
  const ss = D.statusSnap;
  const keys = Object.keys(ss).sort((a,b) => ss[b]-ss[a]);
  new Chart('c1', {
    type:'doughnut',
    data:{ labels:keys, datasets:[{ data:keys.map(k=>ss[k]), backgroundColor:P.map(c => alpha(c,0.85)), borderWidth:1 }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'55%', plugins:{ legend:{ position:'right', labels:{ boxWidth:12, padding:8 } } } },
  });
}

// 2. 담당자 부하
{
  const al = D.assigneeLoad;
  const keys = Object.keys(al).sort((a,b) => al[b]-al[a]).slice(0,10);
  new Chart('c2', {
    type:'bar',
    data:{ labels:keys, datasets:[{ label:'활성 티켓', data:keys.map(k=>al[k]), backgroundColor:alpha('#6554C0',0.7) }] },
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ x:{ beginAtZero:true } } },
  });
}

// 3. 버그 vs 기능
{
  const bf = D.bugVsFeature;
  new Chart('c3', {
    type:'bar',
    data:{
      labels:bf.map(p=>p.label),
      datasets:[
        { label:'버그',    data:bf.map(p=>p.bugs),     backgroundColor:alpha('#FF5630',0.75), stack:'s' },
        { label:'기능/작업', data:bf.map(p=>p.features), backgroundColor:alpha('#0052CC',0.55), stack:'s' },
      ],
    },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'top', labels:{ boxWidth:12 } } }, scales:{ x:{ stacked:true }, y:{ stacked:true, beginAtZero:true } } },
  });
}

// 4. QA 체류
{
  const qa = D.qaAge; const bins = D.bins;
  new Chart('c4', {
    type:'bar',
    data:{
      labels:bins,
      datasets:[
        { label:'FO/BO',   data:bins.map(b=>qa.qa?.[b]||0),     backgroundColor:alpha('#0052CC',0.7), stack:'s' },
        { label:'확인필요', data:bins.map(b=>qa.unclear?.[b]||0), backgroundColor:alpha('#FFAB00',0.7), stack:'s' },
        { label:'개발전용', data:bins.map(b=>qa.dev?.[b]||0),    backgroundColor:alpha('#97A0AF',0.6), stack:'s' },
      ],
    },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'top', labels:{ boxWidth:12 } } }, scales:{ x:{ stacked:true }, y:{ stacked:true, beginAtZero:true } } },
  });
}

// 5. 주제별
{
  const ts = D.themeSnap;
  const tkeys = Object.keys(ts).sort((a,b) => {
    const sa = Object.values(ts[a]).reduce((x,v)=>x+v,0);
    const sb = Object.values(ts[b]).reduce((x,v)=>x+v,0);
    return sb - sa;
  });
  const SC = { 'QA':'#FFAB00','진행 중':'#0052CC','Selected':'#97A0AF','CODE REVIEW':'#6554C0' };
  const allS = [...new Set(tkeys.flatMap(t => Object.keys(ts[t])))];
  new Chart('c5', {
    type:'bar',
    data:{
      labels:tkeys,
      datasets:allS.map((s,i) => ({
        label:s, stack:'s',
        data:tkeys.map(t => ts[t][s]||0),
        backgroundColor:alpha(SC[s]||P[i%P.length], 0.75),
      })),
    },
    options:{
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:'top', labels:{ boxWidth:12, padding:10 } } },
      scales:{ x:{ stacked:true, beginAtZero:true }, y:{ stacked:true } },
    },
  });
}

// ── QA 테이블 ─────────────────────────────────────────
const pTag = p => {
  const m = { Highest:'p-hi', High:'p-h', Medium:'p-m', Low:'p-l' };
  return '<span class="tag ' + (m[p]||'p-l') + '">' + p + '</span>';
};
const tTag = t => {
  if (t==='qa')      return '<span class="tag t-fo">FO/BO</span>';
  if (t==='dev')     return '<span class="tag t-dev">개발전용</span>';
  return '<span class="tag t-unc">확인필요</span>';
};
const sTag = (done, note) => done
  ? '<span class="tag t-done">✅ ' + note + '</span>'
  : '<span class="tag t-todo">⬜ ' + note + '</span>';

let curF = 'all';
function fqa(f, btn) {
  curF = f;
  document.querySelectorAll('.qa-filters button').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  renderQA();
}

function renderQA() {
  const rows = D.qaTable;
  const filtered = rows.filter(r => {
    if (curF==='mytodo') return r.type==='qa' && !r.myDone;
    if (curF==='mydone') return r.type==='qa' && r.myDone;
    if (curF==='dev')    return r.type==='dev';
    return true;
  });
  // 카운트 업데이트
  document.getElementById('cnt-all').textContent    = '(' + rows.length + ')';
  document.getElementById('cnt-mytodo').textContent = '(' + rows.filter(r=>r.type==='qa'&&!r.myDone).length + ')';
  document.getElementById('cnt-mydone').textContent = '(' + rows.filter(r=>r.type==='qa'&&r.myDone).length + ')';
  document.getElementById('cnt-dev').textContent    = '(' + rows.filter(r=>r.type==='dev').length + ')';

  const tbody = document.getElementById('qtb');
  if (!filtered.length) { tbody.innerHTML = '<tr><td class="empty" colspan="7">항목 없음</td></tr>'; return; }
  tbody.innerHTML = filtered.map(r => {
    const url = JIRA + '/browse/' + r.key;
    const ac  = r.ageDays >= 7 ? ' aw' : '';
    const sum = r.summary.length > 72 ? r.summary.slice(0,72) + '…' : r.summary;
    return '<tr>'
      + '<td><a href="' + url + '" class="jl" target="_blank">' + r.key + '</a></td>'
      + '<td>' + sum + '</td>'
      + '<td>' + r.assignee + '</td>'
      + '<td>' + pTag(r.priority) + '</td>'
      + '<td class="' + ac + '">' + r.ageDays + '일</td>'
      + '<td>' + tTag(r.type) + '</td>'
      + '<td>' + sTag(r.myDone, r.myNote) + '</td>'
      + '</tr>';
  }).join('');
}
renderQA();
</script>
</body>
</html>`;
}

main().catch(e => { console.error('오류:', e.message); process.exit(1); });
