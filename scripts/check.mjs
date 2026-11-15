// Runs in the public usr-status repository on GitHub Actions, never on Cloudflare.
//
// Every run:
//  1. Checks each monitored part of USR from outside Cloudflare.
//  2. Opens an incident file when a check starts failing and resolves it when it recovers.
//  3. Reads every incident file in incidents/, stamps any update written without a time,
//     and writes status.json (read by the app and website) and incidents.json (read by the page).
//  4. Records outage start/end times in history.json for the 90-day uptime bars.
// Files are only rewritten when something actually changed, so the repo is not spammed.
import {readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const API = 'https://api.uniformedsaferides.org/api/v1';

/** What the page lists. `url` parts are checked automatically; the rest only change through incidents. */
export const COMPONENTS = [
  {id: 'rides', name: 'Ride requests and the app', url: `${API}/health`},
  {id: 'messaging', name: 'Ride messages and notifications'},
  {id: 'website', name: 'Website', url: 'https://uniformedsaferides.org/'},
  {id: 'console', name: 'Team console and team pages', url: 'https://gousr.app/'},
  {id: 'support', name: 'Help and support', url: `${API}/support/health`},
];
export const STATUSES = ['Investigating', 'Identified', 'Monitoring', 'Resolved', 'Scheduled', 'In progress', 'Completed', 'Update'];
const REFRESH_WHEN_UP_MS = 6 * 3600_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function isUp(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {signal: AbortSignal.timeout(15_000), headers: {'user-agent': 'usr-status-check'}});
      if (res.status < 500) return true;
    } catch { /* try again */ }
    if (attempt < 3) await sleep(15_000);
  }
  return false;
}
const readJson = (path, fallback) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; } catch { return fallback; } };
const writeIfChanged = (path, text) => { if (existsSync(path) && readFileSync(path, 'utf8') === text) return false; writeFileSync(path, text); return true; };
const iso = d => new Date(d).toISOString();

/** "2026-11-15 16:20", "2026-11-15 16:20 UTC" or an ISO time. Times without a zone are UTC. */
export function parseTime(text) {
  const t = String(text || '').trim().replace(/\s*(UTC|Z|GMT)$/i, '');
  if (!t) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(t);
  const ms = m ? Date.parse(`${m[1]}T${m[2].padStart(2, '0')}:${m[3]}:00Z`) : Date.parse(t);
  return Number.isFinite(ms) ? iso(ms) : null;
}
const stamp = ms => iso(ms).slice(0, 16).replace('T', ' ') + ' UTC';

/**
 * An incident file:
 *   ---
 *   title: Ride requests are failing
 *   affects: rides, messaging
 *   impact: major            (minor, major or maintenance)
 *   starts: 2026-11-20 02:00 (maintenance only)
 *   ends: 2026-11-20 03:00   (maintenance only)
 *   ---
 *   ## Identified
 *   What we found and what people should do.
 *
 *   ## 2026-11-15 16:20 UTC · Investigating
 *   Earlier update.
 * A heading without a time gets the current time written into the file.
 */
export function parseIncident(id, text, now = Date.now()) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  for (const line of (fm ? fm[1] : '').split(/\r?\n/)) { const m = /^\s*([a-z]+)\s*:\s*(.*)$/i.exec(line); if (m) meta[m[1].toLowerCase()] = m[2].trim(); }
  let body = fm ? text.slice(fm[0].length) : text;
  let stamped = false;
  const updates = [];
  const parts = body.split(/^##[ \t]+/m);
  const rebuilt = [parts[0]];
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
    const message = (nl < 0 ? '' : part.slice(nl + 1)).replace(/<!--[\s\S]*?-->/g, '').trim();
    const pieces = heading.split(/\s+[·|-]\s+|\s*·\s*/).map(s => s.trim()).filter(Boolean);
    let at = null, status = null;
    for (const p of pieces) { const t = parseTime(p); if (t && !at) at = t; else { const s = STATUSES.find(x => x.toLowerCase() === p.toLowerCase()); if (s) status = s; } }
    if (!status) status = STATUSES.find(x => heading.toLowerCase().includes(x.toLowerCase())) ?? 'Update';
    if (!at) { at = iso(now); stamped = true; rebuilt.push(`${stamp(now)} · ${status}${nl < 0 ? '\n' : part.slice(nl)}`); }
    else rebuilt.push(part);
    if (message || heading) updates.push({at, status, message: message.slice(0, 2000)});
  }
  updates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const impact = ['minor', 'major', 'maintenance'].includes((meta.impact || '').toLowerCase()) ? meta.impact.toLowerCase() : 'minor';
  const affects = (meta.affects || meta.components || '').split(',').map(s => s.trim().toLowerCase()).filter(id => COMPONENTS.some(c => c.id === id));
  const starts = parseTime(meta.starts), ends = parseTime(meta.ends);
  const latest = updates[0] ?? null;
  let state;
  if (impact === 'maintenance') {
    state = latest && ['Completed', 'Resolved'].includes(latest.status) ? 'completed'
      : starts && now < Date.parse(starts) ? 'scheduled'
      : ends && now >= Date.parse(ends) ? 'completed' : 'in_progress';
  } else state = latest?.status === 'Resolved' ? 'resolved' : 'active';
  const openedAt = updates.length ? updates[updates.length - 1].at : starts ?? iso(now);
  const closedAt = state === 'resolved' || state === 'completed' ? (latest && ['Resolved', 'Completed'].includes(latest.status) ? latest.at : ends ?? latest?.at ?? null) : null;
  const incident = {id, title: (meta.title || 'Service issue').slice(0, 140), impact, affects, state, starts, ends, openedAt, closedAt, updates};
  return {incident, text: stamped ? (fm ? fm[0] : '') + rebuilt.join('## ') : text, stamped};
}

const RANK = {operational: 0, maintenance: 1, degraded: 2, outage: 3};
/** Each component's state right now: the worst of its automatic check and any open incident. */
export function componentStates(monitors, incidents) {
  return COMPONENTS.map(c => {
    let status = monitors[c.id] === 'down' ? 'outage' : 'operational';
    for (const i of incidents) {
      if (!i.affects.includes(c.id)) continue;
      const s = i.impact === 'maintenance' ? (i.state === 'in_progress' ? 'maintenance' : null) : i.state === 'active' ? (i.impact === 'major' ? 'outage' : 'degraded') : null;
      if (s && RANK[s] > RANK[status]) status = s;
    }
    return {id: c.id, name: c.name, monitored: !!c.url, status};
  });
}

/** The one message the app and website banner show: the newest open incident, or maintenance under way. */
export function bannerNotice(incidents) {
  const open = incidents.filter(i => i.state === 'active' || i.state === 'in_progress')
    .sort((a, b) => (b.impact === 'major') - (a.impact === 'major') || Date.parse(b.updates[0]?.at ?? b.openedAt) - Date.parse(a.updates[0]?.at ?? a.openedAt));
  const i = open[0];
  if (!i) return null;
  const u = i.updates[0];
  return {title: i.impact === 'maintenance' ? `Maintenance: ${i.title}` : i.title, message: (u?.message || '').replace(/\s+/g, ' ').slice(0, 600), updatedAt: u?.at ?? i.openedAt};
}

const AUTO_START = c => `---\ntitle: ${c.name} not responding\naffects: ${c.id}\nimpact: major\n---\n`;

async function main() {
  const now = Date.now(), nowIso = iso(now);
  mkdirSync('incidents', {recursive: true});
  const previous = readJson('status.json', {version: 1});
  const history = readJson('history.json', {startedAt: nowIso, outages: [], auto: {}});
  history.auto ??= {};
  let changed = false;

  // 1. Checks
  const monitored = COMPONENTS.filter(c => c.url);
  const results = await Promise.all(monitored.map(c => isUp(c.url)));
  const monitors = Object.fromEntries(monitored.map((c, i) => [c.id, results[i] ? 'up' : 'down']));

  // 2. Outage history and automatic incidents
  for (const c of monitored) {
    const open = history.outages.find(o => o.component === c.id && !o.end);
    if (monitors[c.id] === 'down' && !open) {
      history.outages.push({component: c.id, start: nowIso, end: null});
      const file = `incidents/${nowIso.slice(0, 10)}-${c.id}-${nowIso.slice(11, 16).replace(':', '')}.md`;
      writeFileSync(file, `${AUTO_START(c)}## ${stamp(now)} · Investigating\nOur automatic checks can't reach ${c.name.toLowerCase()}. We're looking into it.${c.id === 'rides' ? " If you need a ride now, call your base's ride line." : ''}\n`);
      history.auto[c.id] = file;
      changed = true;
    }
    if (monitors[c.id] === 'up' && open) {
      open.end = nowIso;
      const file = history.auto[c.id];
      if (file && existsSync(file)) {
        const {incident} = parseIncident(file, readFileSync(file, 'utf8'), now);
        if (incident.state === 'active') {
          const text = readFileSync(file, 'utf8');
          const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
          const mins = Math.max(1, Math.round((now - Date.parse(open.start)) / 60000));
          const note = `## ${stamp(now)} · Resolved\nWorking again. Our automatic checks saw this down for about ${mins} minute${mins === 1 ? '' : 's'}. We'll add what happened here.\n\n`;
          writeFileSync(file, fm ? fm[0] + note + text.slice(fm[0].length) : note + text);
        }
      }
      delete history.auto[c.id];
      changed = true;
    }
  }
  const cutoff = now - 100 * 86400_000;
  history.outages = history.outages.filter(o => !o.end || Date.parse(o.end) > cutoff);

  // 3. Incidents
  const incidents = [];
  for (const name of readdirSync('incidents').filter(n => n.endsWith('.md') && !n.startsWith('_')).sort()) {
    const path = `incidents/${name}`;
    const {incident, text, stamped} = parseIncident(name.replace(/\.md$/, ''), readFileSync(path, 'utf8'), now);
    if (stamped) { writeFileSync(path, text); changed = true; }
    incidents.push(incident);
  }
  incidents.sort((a, b) => Date.parse(b.updates[0]?.at ?? b.openedAt) - Date.parse(a.updates[0]?.at ?? a.openedAt));
  const components = componentStates(monitors, incidents);
  const notice = bannerNotice(incidents);

  // 4. Files
  changed = writeIfChanged('incidents.json', JSON.stringify({incidents: incidents.filter(i => !i.closedAt || Date.parse(i.closedAt) > cutoff || i.state === 'scheduled')}, null, 2) + '\n') || changed;
  changed = writeIfChanged('history.json', JSON.stringify(history, null, 2) + '\n') || changed;
  const downApi = monitors.rides === 'down', downWeb = monitors.website === 'down' || monitors.console === 'down';
  const isDown = Object.values(monitors).includes('down');
  const prevChecks = previous.checks ?? {};
  const stale = !previous.checks || now - Date.parse(previous.checks.checkedAt) > REFRESH_WHEN_UP_MS;
  const firstOutage = history.outages.filter(o => !o.end).map(o => o.start).sort()[0] ?? null;
  const next = {version: 1, notice, components, checks: {api: downApi ? 'down' : 'up', website: downWeb ? 'down' : 'up', downSince: firstOutage}};
  const sameAsBefore = JSON.stringify({notice: previous.notice ?? null, components: previous.components, api: prevChecks.api, website: prevChecks.website, downSince: prevChecks.downSince ?? null})
    === JSON.stringify({notice, components, api: next.checks.api, website: next.checks.website, downSince: firstOutage});
  if (!sameAsBefore || isDown || stale || changed) {
    writeFileSync('status.json', JSON.stringify({...next, updatedAt: nowIso, checks: {checkedAt: nowIso, ...next.checks}}, null, 2) + '\n');
    changed = true;
  }
  console.log(`${Object.entries(monitors).map(([k, v]) => `${k} ${v}`).join(', ')}; open incidents ${incidents.filter(i => i.state === 'active').length}; changed ${changed}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
