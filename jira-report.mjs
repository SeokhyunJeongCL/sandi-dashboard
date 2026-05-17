/**
 * SA2025 기획자용 업무 현황 보고서
 * 실행: node jira-report.mjs
 * 저장: node jira-report.mjs --save
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

const env = Object.fromEntries(
  readFileSync(join(__dir, '.env'), 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    .filter(([k]) => k)
);

const BASE = env.JIRA_BASE_URL;
const AUTH = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
const PROJECT = env.JIRA_PROJECT;

// 정석현 계정 ID (raywing@sni.co.kr)
const JSJH_ID = '712020:874a2d08-213b-4b2c-b135-8dca714fc604';

async function jqlAll(query, fields = [], limit = 500) {
  const all = [];
  let nextPageToken = null;
  do {
    const body = { jql: query, fields, maxResults: Math.min(100, limit - all.length) };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jira API ${res.status}`);
    const data = await res.json();
    all.push(...(data.issues || []));
    nextPageToken = data.isLast ? null : data.nextPageToken;
  } while (nextPageToken && all.length < limit);
  return all;
}

// ── 정석현 QA 완료 여부 판정 ─────────────────────
// 체크리스트 개별 항목 상태는 Jira API 미지원 → 댓글 여부로 대체
async function checkJSHQADone(issueKey, progressPct) {
  // 체크리스트 100% → 전원 완료, 정석현 포함
  if (progressPct >= 100) return { done: true, note: '전체완료' };
  try {
    const res = await fetch(`${BASE}/rest/api/3/issue/${issueKey}/comment?maxResults=50`, {
      headers: { 'Authorization': `Basic ${AUTH}` },
    });
    if (!res.ok) return { done: null, note: 'API오류' };
    const data = await res.json();
    const jshCmt = (data.comments || [])
      .filter(c => c.author?.accountId === JSJH_ID)
      .sort((a, b) => (b.created > a.created ? 1 : -1))[0];
    if (jshCmt) {
      const date = (jshCmt.created || '').slice(0, 10);
      return { done: true, note: `댓글 ${date}` };
    }
    return { done: false, note: progressPct === 0 ? '미시작' : '댓글없음' };
  } catch {
    return { done: null, note: '확인불가' };
  }
}

// ── 테마 분류 ──────────────────────────────────
const THEMES = [
  { name: '공간예약/회의실',  keys: ['공간', '예약', '회의실', 'm365', '팀즈', '캘린더', '장기 예약', '당일 예약'] },
  { name: '결제',            keys: ['결제', '환불', '유료'] },
  { name: '출입카드',         keys: ['출입카드', '카드번호', '방재실'] },
  { name: '방문자',           keys: ['방문자', '방문 관리', '방문완료', '스피드게이트'] },
  { name: '비상대피',         keys: ['비상대피', '대피', 'gps'] },
  { name: '로그인/인증/보안', keys: ['로그인', 'jwt', '보안', 'isms', '토큰', '잠금'] },
  { name: 'GS/외부연동',     keys: ['gs', '아워홈', '쿠팡', '사원카드', '온습도'] },
  { name: '로그/인프라/배포', keys: ['로그', 'cdk', '배포', '에이전트', 'flyway', '인스턴스', 'sonar', 'sentry', 'cloudwatch', 'quota'] },
  { name: 'UI/디자인시스템',  keys: ['tailwind', '디자인 시스템', 'ui', '스크롤', '플로팅', '배너', '문구'] },
  { name: 'QR/출입',         keys: ['qr', '출입'] },
  { name: 'Push/알림',       keys: ['push', '알림'] },
];

function classifyTheme(summary) {
  const lower = summary.toLowerCase();
  for (const t of THEMES) {
    if (t.keys.some(k => lower.includes(k))) return t.name;
  }
  return '기타';
}

// ── FO/BO 테스트 가능 여부 ──────────────────────
// 기획자가 직접 앱/백오피스에서 조작해서 확인할 수 있는 것
const TESTABLE_SIGNALS = [
  '[fo]', '[bo]', '화면', '버튼', '스크롤', '목록', '조회', '상세',
  '신청', '승인', '반려', '배너', '알림', '예약 완료', '완료 화면',
  '노출', '표시', '문구', '로그인', '잠금', 'push',
  '출입카드fo', '출입카드 fo', '출입카드bo', '출입카드 bo',
];
const DEV_ONLY_SIGNALS = [
  'cdk', 'flyway', 'sonarqube', '배포라인', '에이전트 코드', '인스턴스',
  'cloudwatch', '로그 제거', '로그 운영', '코드 정리', 'quota',
  'sentry', '환경 설정', '헤더 응답', '제니퍼', 'elb', 'awselb',
  'countStatus', 'webclient', 'http 헤더', '폴링 반복',
];

function isTestableByPlanner(summary) {
  const lower = summary.toLowerCase();
  if (DEV_ONLY_SIGNALS.some(k => lower.includes(k))) return false;
  if (TESTABLE_SIGNALS.some(k => lower.includes(k))) return true;
  // [BO] / [FO] prefix
  if (/^\[(bo|fo)\]/i.test(summary.trim())) return true;
  return null; // 불명확 → 별도 표시
}

// ── 2주 단위 속도 계산 ──────────────────────────
function buildBiweeklyPeriods(n = 6) {
  const periods = [];
  const now = new Date();
  // 오늘을 포함하는 2주 기간의 끝
  for (let i = 0; i < n; i++) {
    const end = new Date(now);
    end.setDate(now.getDate() - i * 14);
    const start = new Date(end);
    start.setDate(end.getDate() - 13);
    periods.unshift({
      label: `${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}`,
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    });
  }
  return periods;
}

function pad(s, n) { const str = String(s); return str + ' '.repeat(Math.max(0, n - str.length)); }
function bar(v, max, w = 20) { const f = max > 0 ? Math.round((v / max) * w) : 0; return '█'.repeat(f) + '░'.repeat(w - f); }

// ── 메인 ──────────────────────────────────────
async function run() {
  const now = new Date();
  const lines = []; // 보고서용

  function out(s = '') { console.log(s); lines.push(s); }

  out('━'.repeat(64));
  out('  SA2025 기획자 현황 보고서');
  out(`  ${now.toLocaleString('ko-KR')}`);
  out('━'.repeat(64));

  // ── 데이터 수집 ────────────────────────────
  const [allIssues, qaIssues, activeIssues, completedIssues] = await Promise.all([
    jqlAll(`project=${PROJECT}`,
      ['summary', 'status', 'assignee', 'priority', 'created', 'updated', 'issuetype'], 500),
    jqlAll(`project=${PROJECT} AND status=QA ORDER BY priority ASC, updated ASC`,
      ['summary', 'assignee', 'priority', 'created', 'updated', 'customfield_10115'], 200),
    jqlAll(`project=${PROJECT} AND status in ("진행 중","Selected","CODE REVIEW","QA") ORDER BY updated DESC`,
      ['summary', 'status', 'assignee', 'priority', 'updated'], 200),
    // 완료된 이슈: statusCategory=Done, updated를 완료 날짜 대리 지표로 사용
    jqlAll(`project=${PROJECT} AND statusCategory=Done ORDER BY updated DESC`,
      ['summary', 'status', 'updated'], 500),
  ]);

  const completed = completedIssues;
  const doneKeys = new Set(completedIssues.map(i => i.key));
  const bugs = allIssues.filter(i =>
    ['Highest', 'High'].includes((i.fields.priority || {}).name) &&
    !doneKeys.has(i.key)
  );

  // ── [1] 요약 ────────────────────────────────
  out('\n[요약]');
  out('─'.repeat(64));
  const inProgress = allIssues.filter(i => i.fields.status.name === '진행 중').length;
  const inQA = qaIssues.length;
  const inSelected = allIssues.filter(i => i.fields.status.name === 'Selected').length;
  const inCodeReview = allIssues.filter(i => i.fields.status.name === 'CODE REVIEW').length;
  out(`  진행 중 ${inProgress}건 | CODE REVIEW ${inCodeReview}건 | QA 대기 ${inQA}건 | 백로그(Selected) ${inSelected}건`);
  out(`  긴급 이슈 (Highest/High 미완료): ${bugs.length}건`);

  // ── [2] 2주 단위 속도 ───────────────────────
  out('\n[1] 2주 단위 완료 속도 (최근 12주)');
  out('─'.repeat(64));
  const periods = buildBiweeklyPeriods(6);
  const velocities = periods.map(p => {
    // resolutiondate가 없으므로 updated 날짜를 완료 시점 대리 지표로 사용
    const count = completed.filter(i => {
      const d = (i.fields.updated || '').slice(0, 10);
      return d >= p.start && d <= p.end;
    }).length;
    return { ...p, count };
  });
  const maxV = Math.max(...velocities.map(v => v.count), 1);
  velocities.forEach(v => {
    out(`  ${pad(v.label, 13)} ${pad(v.count + '건', 5)} ${bar(v.count, maxV)}`);
  });
  const recent2 = velocities.slice(-2).map(v => v.count);
  const trend = recent2[1] > recent2[0] ? '↑ 속도 증가' : recent2[1] < recent2[0] ? '↓ 속도 감소' : '→ 유지';
  out(`  추이: ${trend} (직전 ${recent2[0]}건 → 최근 ${recent2[1]}건)`);

  // ── [3] 현재 집중 업무 (주제별) ─────────────
  out('\n[2] 현재 집중 업무 — 주제별 진행 현황');
  out('─'.repeat(64));
  const themeMap = {};
  activeIssues.forEach(i => {
    const theme = classifyTheme(i.fields.summary);
    if (!themeMap[theme]) themeMap[theme] = { 진행중: 0, QA: 0, CR: 0, 백로그: 0, tickets: [] };
    const s = i.fields.status.name;
    if (s === '진행 중') themeMap[theme].진행중++;
    else if (s === 'QA') themeMap[theme].QA++;
    else if (s === 'CODE REVIEW') themeMap[theme].CR++;
    else themeMap[theme].백로그++;
    themeMap[theme].tickets.push(i);
  });
  Object.entries(themeMap)
    .sort((a, b) => (b[1].QA + b[1].진행중 + b[1].CR) - (a[1].QA + a[1].진행중 + a[1].CR))
    .forEach(([theme, v]) => {
      const total = v.진행중 + v.QA + v.CR + v.백로그;
      const tags = [
        v.진행중 > 0 ? `개발중 ${v.진행중}` : '',
        v.CR > 0 ? `CR ${v.CR}` : '',
        v.QA > 0 ? `QA ${v.QA}` : '',
        v.백로그 > 0 ? `예정 ${v.백로그}` : '',
      ].filter(Boolean).join(' / ');
      out(`  ${pad(theme, 18)} 총 ${pad(total + '건', 4)}  [${tags}]`);
    });

  // ── [4] 긴급 이슈 ───────────────────────────
  out(`\n[3] 긴급 이슈 (Highest/High 미완료) — ${bugs.length}건`);
  out('─'.repeat(64));
  bugs.slice(0, 10).forEach(i => {
    const p = (i.fields.priority || {}).name;
    const s = i.fields.status.name;
    const a = (i.fields.assignee || {}).displayName || '미배정';
    const icon = p === 'Highest' ? '🔴' : '🟠';
    out(`  ${icon} [${i.key}] ${i.fields.summary.slice(0, 50)}`);
    out(`       상태: ${s} | 담당: ${a}`);
  });
  if (bugs.length > 10) out(`  ... 외 ${bugs.length - 10}건`);

  // ── [5] QA — 정석현 완료 여부 분류 ────────────
  out(`\n[4] QA 버킷 — 정석현 완료/미완료 분류`);
  out('─'.repeat(64));
  out('  ※ 체크리스트 개별 항목 API 미지원 → 댓글 기록 기반 판정');
  out('');

  const testable = [];
  const devOnly = [];
  const unclear = [];

  qaIssues.forEach(i => {
    const result = isTestableByPlanner(i.fields.summary);
    if (result === true) testable.push(i);
    else if (result === false) devOnly.push(i);
    else unclear.push(i);
  });

  // 정석현 QA 완료 여부 병렬 조회 (testable + unclear 대상)
  const checkTargets = [...testable, ...unclear];
  const checkResults = await Promise.all(
    checkTargets.map(async i => {
      const pct = i.fields.customfield_10115 ?? null;
      const status = await checkJSHQADone(i.key, pct);
      return { key: i.key, pct, ...status };
    })
  );
  const checkMap = Object.fromEntries(checkResults.map(r => [r.key, r]));

  const tDone   = testable.filter(i => checkMap[i.key]?.done === true);
  const tNotDone = testable.filter(i => checkMap[i.key]?.done !== true);
  const uDone   = unclear.filter(i => checkMap[i.key]?.done === true);
  const uNotDone = unclear.filter(i => checkMap[i.key]?.done !== true);

  out(`  FO/BO 테스트: ${testable.length}건 (미완료 ${tNotDone.length} / 완료 ${tDone.length})`);
  out(`  확인필요:     ${unclear.length}건 (미완료 ${uNotDone.length} / 완료 ${uDone.length})`);
  out(`  개발자전용:   ${devOnly.length}건`);
  out('');

  // ── 미완료 먼저 ──
  if (tNotDone.length > 0) {
    out('  ▶ FO/BO — 아직 내가 확인 안 한 항목');
    tNotDone.forEach(i => {
      const a = (i.fields.assignee || {}).displayName || '미배정';
      const p = (i.fields.priority || {}).name || '-';
      const daysSince = Math.round((now - new Date(i.fields.updated)) / 86400000);
      const stale = daysSince >= 3 ? ` ⚠️ ${daysSince}일 경과` : '';
      const note = checkMap[i.key]?.note || '';
      out(`    ⬜ [${i.key}] ${i.fields.summary.slice(0, 48)}`);
      out(`         담당: ${a} | 우선순위: ${p}${stale} [${note}]`);
    });
    out('');
  }

  if (tDone.length > 0) {
    out('  ▶ FO/BO — 내가 QA 완료한 항목');
    tDone.forEach(i => {
      const note = checkMap[i.key]?.note || '';
      out(`    ✅ [${i.key}] ${i.fields.summary.slice(0, 50)} (${note})`);
    });
    out('');
  }

  if (uNotDone.length > 0) {
    out('  ▶ 확인필요 — FO/BO 여부 불명확, 미확인');
    uNotDone.forEach(i => {
      const a = (i.fields.assignee || {}).displayName || '미배정';
      const note = checkMap[i.key]?.note || '';
      out(`    ⬜ [${i.key}] ${i.fields.summary.slice(0, 48)} (${a}) [${note}]`);
    });
    out('');
  }

  if (uDone.length > 0) {
    out('  ▶ 확인필요 — 완료');
    uDone.forEach(i => {
      const note = checkMap[i.key]?.note || '';
      out(`    ✅ [${i.key}] ${i.fields.summary.slice(0, 50)} (${note})`);
    });
    out('');
  }

  out('  ── 개발자 전용 (기획자 테스트 불필요) ──');
  devOnly.forEach(i => {
    out(`    [${i.key}] ${i.fields.summary.slice(0, 55)}`);
  });

  // ── [6] 기획자 준비사항 ─────────────────────
  out('\n[5] 기획자 준비사항');
  out('─'.repeat(64));

  // CODE REVIEW → QA로 넘어올 것들
  const nextQA = activeIssues.filter(i => i.fields.status.name === 'CODE REVIEW');
  if (nextQA.length > 0) {
    out(`  ▶ CODE REVIEW 중 → 곧 QA로 넘어올 항목 (${nextQA.length}건)`);
    nextQA.forEach(i => {
      const testable = isTestableByPlanner(i.fields.summary);
      const flag = testable === true ? ' [테스트 필요]' : testable === false ? ' [개발자 전용]' : ' [확인필요]';
      out(`    [${i.key}] ${i.fields.summary.slice(0, 50)}${flag}`);
    });
  }

  // Ready for deployment
  const readyToDeploy = allIssues.filter(i => i.fields.status.name === 'Ready for deployment');
  if (readyToDeploy.length > 0) {
    out(`\n  ▶ 배포 준비 완료 — 릴리즈 노트/공지 검토 필요 (${readyToDeploy.length}건)`);
    readyToDeploy.forEach(i => {
      out(`    [${i.key}] ${i.fields.summary.slice(0, 55)}`);
    });
  }

  // QA 3일+ 방치 (미완료 항목만)
  const staleQA = tNotDone.filter(i =>
    Math.round((now - new Date(i.fields.updated)) / 86400000) >= 3
  );
  if (staleQA.length > 0) {
    out(`\n  ▶ QA 3일 이상 미완료 방치 — 확인 또는 담당자 독촉 필요 (${staleQA.length}건)`);
    staleQA.forEach(i => {
      const days = Math.round((now - new Date(i.fields.updated)) / 86400000);
      out(`    [${i.key}] ${i.fields.summary.slice(0, 48)} (${days}일)`);
    });
  }

  // Highest 이슈 중 QA인 것 → 최우선 테스트
  const urgentQA = tNotDone.filter(i => (i.fields.priority || {}).name === 'Highest');
  if (urgentQA.length > 0) {
    out(`\n  ▶ Highest 우선순위 QA — 최우선 테스트 (${urgentQA.length}건)`);
    urgentQA.forEach(i => {
      out(`    🔴 [${i.key}] ${i.fields.summary.slice(0, 55)}`);
    });
  }

  // ── [7] 담당자별 부하 ───────────────────────
  out('\n[6] 담당자별 활성 티켓 현황');
  out('─'.repeat(64));
  const assigneeLoad = {};
  activeIssues.forEach(i => {
    const a = (i.fields.assignee || {}).displayName || '미배정';
    const s = i.fields.status.name;
    if (!assigneeLoad[a]) assigneeLoad[a] = { total: 0, byStatus: {} };
    assigneeLoad[a].total++;
    assigneeLoad[a].byStatus[s] = (assigneeLoad[a].byStatus[s] || 0) + 1;
  });
  const maxLoad = Math.max(...Object.values(assigneeLoad).map(v => v.total), 1);
  Object.entries(assigneeLoad)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([name, v]) => {
      const detail = Object.entries(v.byStatus).map(([s, c]) => `${s} ${c}`).join(' / ');
      out(`  ${pad(name, 10)} ${pad(v.total + '건', 4)} ${bar(v.total, maxLoad, 15)}  ${detail}`);
    });

  out('\n' + '━'.repeat(64));
  out('  보고서 완료');
  out('━'.repeat(64));

  // ── 저장 ──────────────────────────────────
  if (process.argv.includes('--save')) {
    const dateStr = now.toISOString().slice(0, 10);
    const path = join(__dir, `report_${dateStr}.md`);
    writeFileSync(path, lines.join('\n'), 'utf8');
    console.log(`\n저장: ${path}`);
  }
}

run().catch(e => { console.error('오류:', e.message); process.exit(1); });
