import { readFileSync } from 'fs';
const d = JSON.parse(readFileSync('D:/04.vscode/jira/tmp_fields.json', 'utf8'));
const f = d.issues?.[0]?.fields || {};
const keys = Object.keys(f).filter(k => k.startsWith('customfield'));
keys.forEach(k => {
  const v = f[k];
  if (v !== null && v !== undefined) {
    const preview = JSON.stringify(v).slice(0, 150);
    console.log(k + ': ' + preview);
  }
});
