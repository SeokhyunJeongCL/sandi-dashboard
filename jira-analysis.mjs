/**
 * SA2025 Jira 종합 분석 스크립트
 * 실행: node jira-analysis.mjs
 * 기능: 상태별/담당자별/속도 분석 + 주요 이슈 리포트
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

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

// 페이지네이션 처리 (nextPageToken 방식)
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
    if (!res.ok) throw new Error(`Jira API 오류: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all.push(...(data.issues || []));
    nextPageToken = data.isLast ? null : data.nextPageToken;
  } while (nextPageToken && all.length < limit);
  return all;
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));
}

function pad(str, len) {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, len - s.length));
}

function bar(n, max, width = 20) {
  const filled = Math.round((n / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ─────────────────────────────────────────────
async function run() {
  console.log('━'.repeat(60));
  console.log('  SA2025 Jira 종합 분석 리포트');
  console.log(`  ${new Date().toLocaleString('ko-KR')}`);
  console.log('━'.repeat(60));

  // 1. 전체 티켓 수집
  const issues = await jqlAll(
    `project=${PROJECT}`,
    ['summary', 'status', 'assignee', 'priority', 'created', 'updated', 'resolutiondate', 'issuetype'],
    500
  );
  console.log(`\n전체 티켓: ${issues.length}개`);

  // 2. 상태별 집계
  const byStatus = {};
  const byAssignee = {};
  const byPriority = {};
  const completedIssues = [];
  const stuckIssues = []; // 5일 이상 정체

  const now = new Date();

  for (const i of issues) {
    const f = i.fields;
    const status = f.status.name;
    const assignee = (f.assignee || {}).displayName || '미배정';
    const priority = (f.priority || {}).name || '없음';
    const updated = new Date(f.updated);
    const daysSinceUpdate = daysBetween(f.updated, now);

    byStatus[status] = (byStatus[status] || 0) + 1;
    byAssignee[assignee] = (byAssignee[assignee] || 0) + 1;
    byPriority[priority] = (byPriority[priority] || 0) + 1;

    if (f.resolutiondate) {
      const cycleTime = daysBetween(f.created, f.resolutiondate);
      completedIssues.push({ key: i.key, summary: f.summary, cycleTime, assignee });
    }

    const activeStatuses = ['진행 중', 'In Progress', 'CODE REVIEW', 'QA', 'Selected'];
    if (activeStatuses.includes(status) && daysSinceUpdate >= 5) {
      stuckIssues.push({ key: i.key, summary: f.summary, status, assignee, days: daysSinceUpdate });
    }
  }

  // 3. 상태별 현황
  console.log('\n[1] 상태별 현황');
  console.log('─'.repeat(50));
  const maxStatusCount = Math.max(...Object.values(byStatus));
  Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => {
      console.log(`  ${pad(k, 22)} ${pad(v + '개', 5)} ${bar(v, maxStatusCount)}`);
    });

  // 4. 담당자별 현황
  console.log('\n[2] 담당자별 티켓 수');
  console.log('─'.repeat(50));
  const maxAssigneeCount = Math.max(...Object.values(byAssignee));
  Object.entries(byAssignee)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => {
      console.log(`  ${pad(k, 12)} ${pad(v + '개', 5)} ${bar(v, maxAssigneeCount)}`);
    });

  // 5. 우선순위별
  console.log('\n[3] 우선순위별');
  console.log('─'.repeat(50));
  const priorityOrder = ['Highest', 'High', 'Medium', 'Low'];
  priorityOrder.forEach(p => {
    if (byPriority[p]) {
      const icon = p === 'Highest' ? '🔴' : p === 'High' ? '🟠' : p === 'Medium' ? '🟡' : '🟢';
      console.log(`  ${icon} ${pad(p, 10)} ${byPriority[p]}개`);
    }
  });

  // 6. QA 버킷
  const qaIssues = await jqlAll(
    `project=${PROJECT} AND status=QA ORDER BY updated DESC`,
    ['summary', 'assignee', 'priority', 'created', 'updated'],
    100
  );
  console.log(`\n[4] QA 버킷 현황 — ${qaIssues.length}개`);
  console.log('─'.repeat(60));
  if (qaIssues.length === 0) {
    console.log('  QA 대기 티켓 없음');
  } else {
    qaIssues.forEach(i => {
      const f = i.fields;
      const a = (f.assignee || {}).displayName || '미배정';
      const p = (f.priority || {}).name || '-';
      const days = daysBetween(f.updated, now);
      const flag = days >= 3 ? ' ⚠️' : '';
      console.log(`  [${i.key}] ${f.summary.slice(0, 45)}`);
      console.log(`         담당: ${a} | 우선순위: ${p} | 마지막수정 ${days}일 전${flag}`);
    });
  }

  // 7. 정체 이슈
  console.log(`\n[5] 정체 이슈 (5일 이상 업데이트 없음) — ${stuckIssues.length}건`);
  console.log('─'.repeat(60));
  if (stuckIssues.length === 0) {
    console.log('  정체 이슈 없음');
  } else {
    stuckIssues
      .sort((a, b) => b.days - a.days)
      .slice(0, 10)
      .forEach(i => {
        console.log(`  [${i.key}] ${i.summary.slice(0, 40)}`);
        console.log(`         상태: ${i.status} | 담당: ${i.assignee} | ${i.days}일 정체`);
      });
  }

  // 8. Cycle Time (완료 기준)
  if (completedIssues.length > 0) {
    const avg = Math.round(completedIssues.reduce((s, i) => s + i.cycleTime, 0) / completedIssues.length);
    const sorted = [...completedIssues].sort((a, b) => a.cycleTime - b.cycleTime);
    const p50 = sorted[Math.floor(sorted.length * 0.5)]?.cycleTime ?? '-';
    const p90 = sorted[Math.floor(sorted.length * 0.9)]?.cycleTime ?? '-';
    console.log(`\n[6] Cycle Time 분석 (완료 ${completedIssues.length}건 기준)`);
    console.log('─'.repeat(50));
    console.log(`  평균: ${avg}일 | P50: ${p50}일 | P90: ${p90}일`);
  }

  // 9. 최근 7일 완료
  const recentIssues = await jqlAll(
    `project=${PROJECT} AND status changed to 완료됨 AFTER -7d`,
    ['summary', 'assignee', 'resolutiondate'],
    50
  );
  console.log(`\n[7] 최근 7일 완료 — ${recentIssues.length}건`);
  console.log('─'.repeat(50));
  recentIssues.slice(0, 5).forEach(i => {
    const a = (i.fields.assignee || {}).displayName || '미배정';
    console.log(`  [${i.key}] ${i.fields.summary.slice(0, 45)} (${a})`);
  });
  if (recentIssues.length > 5) console.log(`  ... 외 ${recentIssues.length - 5}건`);

  console.log('\n' + '━'.repeat(60));
  console.log('  분석 완료');
  console.log('━'.repeat(60));

  // 보고서 파일 저장 (--save 옵션)
  if (process.argv.includes('--save')) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const reportPath = join(__dir, `report_${dateStr}.md`);
    const lines = [
      `# SA2025 Jira 분석 리포트 — ${dateStr}`,
      '',
      `## 요약`,
      `- 전체 티켓: ${issues.length}개`,
      `- QA 버킷: ${qaIssues.length}개`,
      `- 정체 이슈 (5일+): ${stuckIssues.length}건`,
      `- 최근 7일 완료: ${recentIssues.length}건`,
      '',
      `## 상태별`,
      ...Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`- ${k}: ${v}개`),
      '',
      `## 담당자별`,
      ...Object.entries(byAssignee).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`- ${k}: ${v}개`),
      '',
      `## QA 버킷 (${qaIssues.length}개)`,
      ...qaIssues.map(i => {
        const a = (i.fields.assignee||{}).displayName||'미배정';
        const p = (i.fields.priority||{}).name||'-';
        const days = daysBetween(i.fields.updated, new Date());
        return `- [${i.key}] ${i.fields.summary} | 담당:${a} | ${p} | ${days}일 전`;
      }),
      '',
      `## 정체 이슈 상위 10건`,
      ...stuckIssues.sort((a,b)=>b.days-a.days).slice(0,10)
        .map(i=>`- [${i.key}] ${i.summary} | ${i.status} | ${i.assignee} | ${i.days}일`),
    ];
    writeFileSync(reportPath, lines.join('\n'));
    console.log(`\n보고서 저장: ${reportPath}`);
  }
}

run().catch(e => {
  console.error('오류:', e.message);
  process.exit(1);
});
