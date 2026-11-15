// Runs in the public usr-status repository on GitHub Actions, never on Cloudflare.
// Checks USR from outside, reads NOTICE.md, and rewrites status.json / ride-lines.json only when
// something changed, so the page and the app can tell people what is happening during an outage.
import {readFileSync, writeFileSync, appendFileSync, existsSync} from 'node:fs';

const API = 'https://api.uniformedsaferides.org/api/v1';
const WEBSITE = 'https://uniformedsaferides.org/';
const REFRESH_WHEN_UP_MS = 6 * 3600_000; // keeps the "last checked" time from going stale for days
const now = new Date().toISOString();

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function up(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {signal: AbortSignal.timeout(15_000), headers: {'user-agent': 'usr-status-check'}});
      if (res.status < 500) return true;
    } catch { /* try again */ }
    if (attempt < 3) await sleep(15_000);
  }
  return false;
}

function readJson(path, fallback) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; } catch { return fallback; }
}

/** First real line is the title, the rest is the message. Lines inside <!-- --> are instructions, not content. */
function readNotice() {
  if (!existsSync('NOTICE.md')) return null;
  const lines = readFileSync('NOTICE.md', 'utf8').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).map(l => l.trim());
  const start = lines.findIndex(Boolean);
  if (start < 0) return null;
  const title = lines[start].replace(/^#+\s*/, '').slice(0, 120);
  const message = lines.slice(start + 1).filter(Boolean).join(' ').slice(0, 600);
  return title ? {title, message} : null;
}

const previous = readJson('status.json', {version: 1, updatedAt: now, notice: null, checks: null});
const [api, website] = await Promise.all([up(`${API}/health`), up(WEBSITE)]);
const apiState = api ? 'up' : 'down', websiteState = website ? 'up' : 'down';
const wasDown = previous.checks?.api === 'down' || previous.checks?.website === 'down';
const isDown = apiState === 'down' || websiteState === 'down';
const downSince = isDown ? (wasDown && previous.checks?.downSince) || now : null;

const text = readNotice();
const sameNotice = text && previous.notice && previous.notice.title === text.title && previous.notice.message === text.message;
const notice = text ? {...text, updatedAt: sameNotice ? previous.notice.updatedAt : now} : null;

const stateChanged = previous.checks?.api !== apiState || previous.checks?.website !== websiteState;
const noticeChanged = JSON.stringify(previous.notice ?? null) !== JSON.stringify(notice);
const stale = !previous.checks || Date.now() - Date.parse(previous.checks.checkedAt) > REFRESH_WHEN_UP_MS;
let changed = false;

// While anything is down, write every run so apps can trust the "down" report is current.
if (stateChanged || noticeChanged || isDown || stale) {
  writeFileSync('status.json', JSON.stringify({version: 1, updatedAt: now, notice, checks: {checkedAt: now, api: apiState, website: websiteState, downSince}}, null, 2) + '\n');
  changed = true;
}

// Copy the public ride lines while the API is up. Never replace a good list with a failed one.
if (api) {
  try {
    const res = await fetch(`${API}/programs/public-ride-lines`, {signal: AbortSignal.timeout(20_000)});
    const body = res.ok ? await res.json() : null;
    const teams = body?.success && Array.isArray(body.data?.teams) ? body.data.teams : null;
    const saved = readJson('ride-lines.json', {teams: []});
    if (teams && JSON.stringify(teams) !== JSON.stringify(saved.teams)) {
      writeFileSync('ride-lines.json', JSON.stringify({updatedAt: now, teams}, null, 2) + '\n');
      changed = true;
    }
  } catch (error) { console.log(`ride lines not refreshed: ${error.message}`); }
}

console.log(`api ${apiState}, website ${websiteState}, notice ${notice ? `"${notice.title}"` : 'none'}, changed ${changed}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
