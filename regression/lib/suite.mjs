// The suite's frame: lines, results, screenshots, and the one browser.
//
// A line is one capability a person relies on, written down in CAPABILITIES.md with the same id.
// Each check returns { ok, detail } or throws; a throw is a failure with its message as the
// detail. Every failure is screenshotted. A line that cannot run here (no funded wallet, a surface
// with no live page) is SKIP with its reason, never PASS.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The testnet faucet pays each asset once per wallet and once a day to one network, and never
// refuses our own tooling: a request carrying the token the box keeps for it, as `X-Faucet-Exempt`
// (sequentia-faucet, "Once per wallet"), is neither checked nor recorded. The suite reads the
// token from FAUCET_EXEMPT_TOKEN_FILE, else ~/.config/sequentia/faucet-exempt.token, and without
// one runs as any tester does.
export function faucetToken (env = process.env) {
  const f = env.FAUCET_EXEMPT_TOKEN_FILE || join(homedir(), '.config/sequentia/faucet-exempt.token')
  try { const t = readFileSync(f, 'utf8').trim(); return t.length >= 32 ? t : null } catch { return null }
}
// Adds the token to the page's requests to `origin`/faucet, and to no other request, so it never
// reaches another host. -> whether it is on.
export async function faucetPass (b, page, origin, token = faucetToken()) {
  if (!token) return false
  b.on((m) => {
    if (m.sessionId !== page.sessionId || m.method !== 'Fetch.requestPaused') return
    const q = m.params
    const headers = Object.entries(q.request.headers || {}).filter(([k]) => k.toLowerCase() !== 'x-faucet-exempt').map(([name, value]) => ({ name, value }))
    if (q.request.url.startsWith(origin + '/faucet')) headers.push({ name: 'X-Faucet-Exempt', value: token })
    b.send('Fetch.continueRequest', { requestId: q.requestId, headers }, page.sessionId).catch(() => {})
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: origin + '/faucet*', requestStage: 'Request' }] }, page.sessionId)
  return true
}

// Phone: a 390 x 844 touch screen; desktop: 1440 x 1000.
export const WIDTHS = {
  desktop: { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 },
  phone: { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 },
}

export function chrome () {
  if (process.env.CHROME) return process.env.CHROME
  const base = join(homedir(), '.cache/ms-playwright')
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort() : []
  if (dirs.length) return join(base, dirs[dirs.length - 1], 'chrome-linux64/chrome')
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (existsSync(p)) return p
  throw new Error('no Chromium: set CHROME')
}

// The browsers still running on `profile` (an exact `--user-data-dir=<profile>` argument), other
// than this process: [{ pid, comm }]. Linux only (/proc); elsewhere none are found. A browser left
// by a run that died keeps its wallets open and keeps trading from them, so the next run on the
// same profile would share its wallet with a second live copy of it.
export function browsersOn (profile, proc = '/proc') {
  const want = `--user-data-dir=${profile}`
  const out = []
  let pids = []
  try { pids = readdirSync(proc).filter((p) => /^\d+$/.test(p)) } catch { return out }
  for (const p of pids) {
    if (Number(p) === process.pid) continue
    let args, comm
    // Chromium rewrites its process title: its arguments read as one string joined by spaces, not
    // one per NUL. Either way, the argument is a whole word.
    try { args = readFileSync(join(proc, p, 'cmdline'), 'utf8').split(/[\0 ]/); comm = readFileSync(join(proc, p, 'comm'), 'utf8').trim() } catch { continue }
    if (args.includes(want) && /chrom|headless/i.test(comm)) out.push({ pid: Number(p), comm })
  }
  return out
}

// Stops the browsers browsersOn finds, by pid: asked to end, then killed after `graceMs`. -> the
// pids it found.
export async function stopBrowsersOn (profile, { graceMs = 3000, proc = '/proc' } = {}) {
  const found = browsersOn(profile, proc)
  for (const b of found) { try { process.kill(b.pid, 'SIGTERM') } catch {} }
  if (found.length) await sleep(graceMs)
  for (const b of browsersOn(profile, proc)) { try { process.kill(b.pid, 'SIGKILL') } catch {} }
  return found.map((b) => b.pid)
}

// A fresh shallow clone of a ConcatenaLabs repository's default branch, under the cache.
export function clone (cache, repo) {
  const dir = join(cache, repo)
  rmSync(dir, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', '--depth', '1', `https://github.com/ConcatenaLabs/${repo}.git`, dir], { stdio: ['ignore', 'ignore', 'inherit'] })
  return { dir, rev: execFileSync('git', ['-C', dir, 'rev-parse', '--short=10', 'HEAD']).toString().trim() }
}

export class Report {
  constructor (out, known = {}) {
    this.out = out; this.known = known; mkdirSync(out, { recursive: true })
    this.log = join(out, 'results.txt')
    this.rows = []
    // Counts the summary prints, each with the lines it counts: `tally('…', id)`.
    this.counts = {}
  }

  tally (key, id) { (this.counts[key] = this.counts[key] || []).push(id) }

  note (s) { console.log(s); appendFileSync(this.log, s + '\n') }

  record (id, width, status, line, detail, shot) {
    this.rows.push({ id, width, status, line, detail, shot })
    const d = detail === undefined || detail === '' ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
    const k = status === 'FAIL' && this.known[id] ? `\n       known: ${this.known[id]}` : ''
    this.note(`${status.padEnd(4)} ${id.padEnd(14)} ${(width || '-').padEnd(7)} ${line}${d.length > 400 ? d.slice(0, 400) + '…' : d}${shot ? '  [' + shot + ']' : ''}${k}`)
  }

  // Runs one line. `page` (optional) is screenshotted on failure, with the result's `at`
  // (a selector) scrolled into view.
  async line (id, width, line, page, fn) {
    let r
    try { r = await fn() } catch (e) { r = { ok: false, detail: String(e && e.message || e).split('\n')[0] } }
    if (r && r.skip) return this.record(id, width, 'SKIP', line, r.skip)
    let shot
    if (!r.ok && page) {
      // A check may name the control it failed on (`at`): it is brought into view first.
      if (r.at) await page.eval(`(document.querySelector(${JSON.stringify(r.at)})||{scrollIntoView(){}}).scrollIntoView({block:'center'}), true`).catch(() => {})
      shot = `${id}-${width || 'any'}.png`
      try { await page.shot(join(this.out, shot)) } catch { shot = undefined }
    }
    this.record(id, width, r.ok ? 'PASS' : 'FAIL', line, r.detail, shot)
    return r.ok
  }

  skip (id, width, line, why) { this.record(id, width, 'SKIP', line, why) }

  summary () {
    const n = (s) => this.rows.filter((r) => r.status === s).length
    this.note(`\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped. Screenshots and this list: ${this.out}`)
    for (const [k, ids] of Object.entries(this.counts)) this.note(`${k}: ${ids.length}${ids.length ? ' (' + ids.join(' ') + ')' : ''}`)
    const failed = this.rows.filter((r) => r.status === 'FAIL')
    const ids = [...new Set(failed.map((r) => r.id))]
    const fresh = ids.filter((i) => !this.known[i])
    if (ids.length) this.note('Failing lines: ' + ids.join(' '))
    if (fresh.length) this.note('Not in known.json (new, or a check to fix): ' + fresh.join(' '))
    for (const i of Object.keys(this.known)) if (i !== '_' && this.rows.some((r) => r.id === i) && !ids.includes(i)) this.note(`${i} passes now: take it out of known.json`)
    return failed.length
  }
}

// Page helpers over the extension's CDP Page (test/leaves/cdp.mjs): what every check needs.
export function helpers (page) {
  const q = JSON.stringify
  return {
    page,
    eval: (e) => page.eval(e),
    waitFor: (e, ms) => page.waitFor(e, ms),
    visible: (sel) => page.eval(`(()=>{const e=document.querySelector(${q(sel)}); return !!e && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden'})()`),
    text: (sel) => page.eval(`((document.querySelector(${q(sel)})||{}).innerText||'').trim()`),
    click: (sel) => page.click(sel),
    // A click on the visible element whose own text is `label` (a button, a tab).
    clickText: (sel, label) => page.eval(`(()=>{const e=[...document.querySelectorAll(${q(sel)})].find(x=>x.getClientRects().length && x.innerText.trim()===${q(label)}); if(!e) throw new Error('no ${String(label).replace(/'/g, '')}'); e.click(); return true})()`),
    type: (sel, v) => page.eval(`(()=>{const i=document.querySelector(${q(sel)}); if(!i) throw new Error('no ${sel.replace(/'/g, '')}'); i.focus(); i.value=${q(String(v))}; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return true})()`),
    bodyText: () => page.eval('document.body.innerText'),
    // The page is no wider than the screen: nothing scrolls sideways.
    overflow: () => page.eval('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth'),
  }
}

export async function setWidth (b, page, w) {
  const m = WIDTHS[w]
  await b.send('Emulation.setDeviceMetricsOverride', { width: m.width, height: m.height, deviceScaleFactor: m.deviceScaleFactor, mobile: m.mobile }, page.sessionId)
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: m.mobile }, page.sessionId).catch(() => {})
}

// The words default mode never shows, read from the deployed web wallet itself
// (USER_MODE_FORBIDDEN_WORDS in user-trade.js), so the list here never drifts from the contract.
// The deployed web wallet's USER_MODE_FORBIDDEN_WORDS, read here rather than in the page: a page's
// own content policy (Ambra browser's popup allows only its own scripts) may refuse the import.
export async function forbiddenWords () {
  const r = await fetch('https://sequentiatestnet.com/wallet/user-trade.js', { cache: 'no-store' })
  if (!r.ok) throw new Error('user-trade.js: HTTP ' + r.status)
  const m = /USER_MODE_FORBIDDEN_WORDS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(await r.text())
  if (!m) throw new Error('user-trade.js names no USER_MODE_FORBIDDEN_WORDS')
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}
export function forbiddenIn (text, words) {
  const t = ' ' + String(text).toLowerCase().replace(/[^a-z0-9-]+/g, ' ') + ' '
  return words.filter((w) => t.includes(' ' + w.toLowerCase() + ' ') || t.includes(' ' + w.toLowerCase() + 's '))
}

// What a picker shows after one click on the control named `sel`: the rows a person can choose
// from (a searchable list, or a plain <select>'s options), and the search box if there is one.
export const PICKER = (sel) => `(async()=>{
  const c=document.querySelector(${JSON.stringify(sel)}); if(!c) throw new Error('no ${sel}');
  const vis=(e)=>e && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden';
  if(c.tagName==='SELECT') return { kind:'select', search:false, rows:[...c.options].map(o=>o.text.trim()) };
  c.click(); await new Promise(r=>setTimeout(r,700));
  const search=[...document.querySelectorAll('input')].find(i=>vis(i) && /search/i.test((i.placeholder||'')+' '+(i.getAttribute('aria-label')||'')));
  const rows=[...document.querySelectorAll('[role=option]')].filter(o=>vis(o) && !o.classList.contains('swopt-other')).map(o=>{const t=o.querySelector('.swopt-tk,[data-ticker]'); return (t?t.innerText:o.innerText).trim().split(/\\s+/)[0].replace(/[^A-Za-z0-9.\\-…]/g,'')});
  const groups=[...document.querySelectorAll('.swopt-grp')].filter(vis).map(g=>g.innerText.trim());
  return { kind:'list', search:!!search, rows, groups };
})()`
// Types into the open picker's search box; -> the rows shown.
export const SEARCH = (q) => `(async()=>{
  const vis=(e)=>e && e.getClientRects().length>0;
  const i=[...document.querySelectorAll('input')].find(x=>vis(x) && /search/i.test((x.placeholder||'')+' '+(x.getAttribute('aria-label')||'')));
  if(!i) return null;
  i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,500));
  return [...document.querySelectorAll('[role=option]')].filter(o=>vis(o) && !o.classList.contains('swopt-other')).map(o=>{const t=o.querySelector('.swopt-tk,[data-ticker]'); return (t?t.innerText:o.innerText).trim().split(/\\s+/)[0].replace(/[^A-Za-z0-9.\\-…]/g,'')});
})()`
export const CLOSE = `(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); const i=[...document.querySelectorAll('input')].find(x=>x.getClientRects().length && /search/i.test(x.placeholder||'')); if(i) i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.body.click(); return true})()`
