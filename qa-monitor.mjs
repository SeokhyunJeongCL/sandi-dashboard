/**
 * SA2025 QA 버킷 모니터 — 신규 티켓 감지 시 Windows 알림
 * 실행: node qa-monitor.mjs
 * 동작: 5분마다 QA 버킷 폴링 → 신규 티켓 발견 시 Windows 토스트 알림
 * 백그라운드 실행: node qa-monitor.mjs &   또는   작업 스케줄러 등록
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dir, '.qa-state.json');
const LOG_FILE = join(__dir, 'qa-monitor.log');

// .env 파싱 — 값에 = 포함 가능 (API 토큰 등)
const env = Object.fromEntries(
  readFileSync(join(__dir, '.env'), 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
    .map(l => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
    .filter(([k]) => k)
);

const BASE = env.JIRA_BASE_URL;
const AUTH = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
const PROJECT = env.JIRA_PROJECT;
const INTERVAL_MS = 5 * 60 * 1000; // 5분

function log(msg) {
  const line = `[${new Date().toLocaleString('ko-KR')}] ${msg}`;
  console.log(line);
  try {
    const prev = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : '';
    const lines = prev.split('\n').filter(Boolean);
    lines.push(line);
    // 로그 최대 500줄 유지
    writeFileSync(LOG_FILE, lines.slice(-500).join('\n') + '\n');
  } catch {}
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { knownKeys: [] };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { knownKeys: [] };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Windows 11 Toast 알림 — 액션센터에 쌓임, 자리 비워도 확인 가능
function notify(title, body) {
  const ps1 = join(__dir, 'notify.ps1');
  const t = title.replace(/"/g, '').replace(/'/g, '');
  const b = body.replace(/"/g, '').replace(/'/g, '').replace(/\n/g, ' ');
  try {
    execSync(`powershell -WindowStyle Hidden -File "${ps1}" -Title "${t}" -Body "${b}"`, { timeout: 10000 });
  } catch (e) {
    log(`알림 전송 실패 (무시): ${e.message.slice(0, 80)}`);
  }
}

async function fetchQA() {
  const all = [];
  let nextPageToken = null;
  do {
    const body = {
      jql: `project=${PROJECT} AND status=QA ORDER BY created DESC`,
      fields: ['summary', 'assignee', 'priority', 'created'],
      maxResults: 100,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API 오류: ${res.status}`);
    const data = await res.json();
    all.push(...(data.issues || []));
    nextPageToken = data.isLast ? null : data.nextPageToken;
  } while (nextPageToken);
  return all;
}

async function poll() {
  try {
    const issues = await fetchQA();
    const currentKeys = new Set(issues.map(i => i.key));
    const state = loadState();
    const knownKeys = new Set(state.knownKeys);

    const newIssues = issues.filter(i => !knownKeys.has(i.key));

    if (newIssues.length > 0) {
      log(`신규 QA 티켓 ${newIssues.length}개 감지`);
      for (const i of newIssues) {
        const a = (i.fields.assignee || {}).displayName || '미배정';
        const p = (i.fields.priority || {}).name || '-';
        const msg = `[${i.key}] ${i.fields.summary.slice(0, 60)}\n담당: ${a} | 우선순위: ${p}`;
        log(`  ${msg}`);
        notify(`QA 신규 티켓: ${i.key}`, msg);
      }
    } else {
      log(`QA 버킷 확인 — 현재 ${issues.length}개 (신규 없음)`);
    }

    // 현재 QA 키 목록으로 상태 갱신
    saveState({ knownKeys: [...currentKeys], lastCheck: new Date().toISOString() });
  } catch (e) {
    log(`폴링 오류: ${e.message}`);
  }
}

// 놓친 알림 요약 출력 (--missed 옵션)
async function showMissed() {
  const state = loadState();
  const lastCheck = state.lastCheck ? new Date(state.lastCheck) : null;
  const issues = await fetchQA();
  const knownKeys = new Set(state.knownKeys || []);
  const missed = issues.filter(i => !knownKeys.has(i.key));

  console.log(`\n=== 놓친 QA 티켓 (마지막 확인: ${lastCheck ? lastCheck.toLocaleString('ko-KR') : '없음'}) ===`);
  if (missed.length === 0) {
    console.log('  놓친 티켓 없음');
  } else {
    missed.forEach(i => {
      const a = (i.fields.assignee || {}).displayName || '미배정';
      const p = (i.fields.priority || {}).name || '-';
      console.log(`  [${i.key}] ${i.fields.summary}`);
      console.log(`         담당: ${a} | 우선순위: ${p}`);
    });
    // 요약 알림 1개로 묶어서 발송
    notify(
      `놓친 QA 티켓 ${missed.length}개`,
      missed.map(i => `[${i.key}] ${i.fields.summary.slice(0, 40)}`).join(' / ')
    );
  }
  console.log(`현재 QA 버킷 전체: ${issues.length}개\n`);
}

// ── 진입점 ──────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--missed')) {
  // 놓친 알림만 확인하고 종료
  await showMissed();
  setTimeout(() => process.exit(0), 300);
} else {
// 데몬 모드 (기본)
log('QA 모니터 시작 (5분 간격)');
log(`프로젝트: ${PROJECT} | ${BASE}`);

(async () => {
  const state = loadState();
  if (state.knownKeys.length === 0) {
    log('초기 상태 수집 중...');
    try {
      const issues = await fetchQA();
      saveState({ knownKeys: issues.map(i => i.key), lastCheck: new Date().toISOString() });
      log(`초기 QA 티켓 ${issues.length}개 기록 완료. 이후 신규 티켓부터 알림 발송.`);
    } catch (e) {
      log(`초기화 오류: ${e.message}`);
    }
  } else {
    // 재시작 시 — 꺼져 있던 동안 추가된 티켓 즉시 알림
    log('재시작 감지 — 부재 중 변경사항 확인 중...');
    await poll();
  }

  setInterval(poll, INTERVAL_MS);
})();
} // end else (daemon mode)
