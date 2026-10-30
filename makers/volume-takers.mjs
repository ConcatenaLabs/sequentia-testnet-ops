#!/usr/bin/env node
// volume-takers.mjs: traders that trade against the SeqDEX makers, so the testnet carries the
// volume of a busy market: every pair of the faucet assets and every pair against BTC, both ways,
// at sizes from tens to tens of thousands of dollars, the side leaning with the price feed. Every
// trade is a real one, settled by the makers' own code on its rail and recorded by the relays in
// the one trade log the tickers and charts read; nothing is printed that did not trade.
//
// Rails, and what carries a trade on each:
//   tree      an in-tree swap through a headless wallet running the wallets' own composer engine
//             (sequentia-web-wallet tooling/user-mode-wallet.mjs, POST /trade), against the agents'
//             own leaf maker, so a person's trade never queues behind theirs
//   pln       a pure-Lightning swap: `seqob-crosser -take … -take-families pureln`
//   onchain   a covenant fill or an interactive lift: `seqob-crosser -take … -take-families covenant,samechain`
// A pair's trades arrive at random (a Poisson process) at the rate that makes its daily target at
// the ramp's current step; each picks a rail by the configured mix among the rails the pair has,
// waits for a free slot on that rail (a rail at its limit is a capacity signal, counted as
// `busy`), and is sized log-uniformly between the configured bounds.
//
// The ramp: steps (a share of the target each), each held for `step_minutes`, and it goes up only
// when the step's last `clean_minutes` broke no rule. Any rule broken holds the ramp at the step
// below and says which (`HOLD` in the log): the box's CPU pressure over `max_cpu_pressure` (the
// share of the last minute its tasks waited for a CPU; the load average over `max_load_share` of
// its cores where the kernel keeps none), a rail's success rate under `min_success` (over its last 50 trades), the in-tree trade's
// p95 time over `max_tree_p95_ms` (the operator's co-signing is most of it), or the wallet probe
// (a person's trade, through the public wallet-facing maker, every `probe_seconds`) slower by more
// than `max_probe_worse_ms` than at the first step. While the operator's finality waits on the
// Bitcoin anchor (`chain`), the in-tree rail and the probe make no trade and the ramp holds (a
// pause, never a step back); Lightning and the chain need no Arca finality and trade on.
//
//   node makers/volume-takers.mjs --config /etc/sequentia/volume-takers.json [--dry-run]
//
// Writes `<state>/trades.jsonl` (one line a trade), `<state>/summary.json` and `<state>/ramp.json`
// every minute, and a summary line to stdout; --dry-run makes no trade and draws each one's
// outcome at random, to check the schedule, the sizing and the ramp.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null }
const cfg = JSON.parse(fs.readFileSync(arg('--config'), 'utf8'))
const DRY = process.argv.includes('--dry-run')
const STATE = cfg.state_dir; fs.mkdirSync(STATE, { recursive: true })
const log = (...a) => console.log(new Date().toISOString(), ...a)
const now = () => Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ASSETS = Object.fromEntries(cfg.assets.map((a) => [a.ticker, a]))   // {ticker, id, precision, feed}
const PAIRS = cfg.pairs.map((p) => ({ ...p, key: `${p.base}/${p.quote}`, rails: p.rails || (p.base === 'BTC' || p.quote === 'BTC' ? ['tree', 'pln'] : ['tree', 'pln', 'onchain']) }))
const MIX = cfg.rail_mix || { tree: 0.5, pln: 0.4, onchain: 0.1 }
const LIMIT = cfg.rail_concurrency || { tree: 4, pln: 8, onchain: 2 }
const SIZE = cfg.size_usd || { min: 50, max: 25000 }
const RAMP = { steps: [0.1, 0.5, 1], step_minutes: 120, clean_minutes: 30, max_cpu_pressure: 25, max_load_share: 0.75, min_success: 0.98, max_tree_p95_ms: 30000,
  max_probe_worse_ms: 1000, probe_seconds: 300, ...(cfg.ramp || {}) }
const meanSize = (SIZE.max - SIZE.min) / Math.log(SIZE.max / SIZE.min)   // log-uniform mean

// ---- the price feed
let feed = {}, lastMid = {}
const px = (t) => { const a = ASSETS[t]; const v = feed[a.feed] ?? feed[t]; const n = Number(v && typeof v === 'object' ? v.price : v); return n > 0 ? n : null }
async function readFeed () { try { feed = await (await fetch(cfg.feed, { signal: AbortSignal.timeout(10000) })).json() } catch (e) { log('feed:', e.message) } }

// ---- what happened
const trades = []   // {t, pair, rail, side, usd, ok, ms, err}
const tradesFile = path.join(STATE, 'trades.jsonl')
const record = (r) => { trades.push(r); fs.appendFileSync(tradesFile, JSON.stringify(r) + '\n') }
let busySkipped = { tree: 0, pln: 0, onchain: 0 }
let pausedSkipped = 0   // in-tree trades not made while the operator's finality waited on the anchor
const inFlight = { tree: 0, pln: 0, onchain: 0 }
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }

// ---- executors
const wallets = (cfg.tree?.wallets || []).map((url) => ({ url, busy: false }))
async function walletTrade (url, pay, receive, amount) {
  const r = await fetch(url + '/trade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pay, receive, amount: String(amount) }),
    signal: AbortSignal.timeout((cfg.tree?.timeout_seconds || 300) * 1000) })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) throw new Error(j.why ? `${j.why}${j.error ? ': ' + j.error : ''}` : (j.error || 'HTTP ' + r.status))
  return j
}
function crosserTake (pair, side, baseAtoms, families) {
  return new Promise((resolve, reject) => {
    const c = cfg.crosser
    const base = ASSETS[pair.base].id, quote = ASSETS[pair.quote].id
    const args = ['-take', `${base}/${quote}`, '-take-side', side, '-take-amount', String(baseAtoms), '-take-families', families,
      '-relays', c.relays.join(','), '-state-dir', c.state_dir, ...(c.args || [])]
    if (c.avoid?.length) args.push('-take-avoid', c.avoid.join(','))
    let out = ''
    const p = spawn(c.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', () => {})
    const kill = setTimeout(() => p.kill('SIGTERM'), (c.timeout_seconds || 600) * 1000)
    p.on('exit', () => {
      clearTimeout(kill)
      const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop()
      let j = {}; try { j = JSON.parse(line) } catch {}
      j.settled ? resolve(j) : reject(new Error(j.error || 'no result'))
    })
  })
}

// A failed take's error as it is kept: the crosser reports a failed command as
// "<command>: exit status N (tail: line | line | ...)" with up to 20 of its lines, and the cause
// is the last of them, so the tail is cut to its last three lines; anything still over 600
// characters keeps its start and its end.
function errText (msg) {
  let m = String(msg ?? '?')
  const at = m.indexOf(' (tail: ')
  if (at >= 0) {
    const lines = m.slice(at + 8).replace(/\)\s*$/, '').split(' | ').map((l) => l.trim()).filter(Boolean)
    m = m.slice(0, at) + ' ... ' + lines.slice(-3).join(' | ')
  }
  return m.length > 600 ? m.slice(0, 200) + ' ... ' + m.slice(-395) : m
}

// One trade: `side` buy = the taker gets the base; usd its size.
async function trade (pair, rail, side, usd) {
  const b = ASSETS[pair.base], q = ASSETS[pair.quote]
  const pb = px(pair.base), pq = px(pair.quote)
  if (!pb || !pq) throw new Error('no price in the feed')
  if (DRY) { await sleep(rail === 'pln' ? 200 : rail === 'tree' ? 3000 : 1500); if (Math.random() < (cfg.dry_fail || 0.005)) throw new Error('dry-run failure'); return {} }
  if (rail === 'tree') {
    const w = wallets.find((x) => !x.busy); if (!w) throw new Error('no idle wallet')
    w.busy = true
    try {
      const [pay, receive, payT, payPx] = side === 'buy' ? [q.id, b.id, q, pq] : [b.id, q.id, b, pb]
      return await walletTrade(w.url, pay, receive, Math.max(1, Math.round(usd / payPx * 10 ** payT.precision)))
    } finally { w.busy = false }
  }
  const atoms = Math.max(1, Math.round(usd / pb * 10 ** b.precision))
  return crosserTake(pair, side, atoms, rail === 'pln' ? 'pureln' : 'covenant,samechain')
}

// ---- the schedule
function pickRail (pair) {
  const rails = pair.rails.filter((r) => (MIX[r] || 0) > 0 && (r !== 'tree' || wallets.length || DRY))
  let x = Math.random() * rails.reduce((s, r) => s + MIX[r], 0)
  for (const r of rails) { x -= MIX[r]; if (x <= 0) return r }
  return rails[rails.length - 1]
}
function pickSide (pair) {
  // lean with the feed: after a move up, more buyers (0.65), after a move down, more sellers
  const m = px(pair.base) / px(pair.quote), was = lastMid[pair.key]; lastMid[pair.key] = m
  const lean = was ? Math.sign(m - was) * 0.15 : 0
  return Math.random() < 0.5 + lean ? 'buy' : 'sell'
}
const pickUsd = () => Math.exp(Math.log(SIZE.min) + Math.random() * Math.log(SIZE.max / SIZE.min))

let step = 0, stepStarted = now(), cleanSince = now(), holdReason = null, probeBase = null
const probes = []
function launch (pair) {
  const rail = pickRail(pair)
  // an in-tree trade waits for the operator's finality; Lightning and the chain do not, so they
  // go on at their own share while the anchor holds it (the share of the tree is not moved onto
  // them: each rail keeps the pace the mix gives it)
  if (rail === 'tree' && chainWait) { pausedSkipped++; return }
  if (inFlight[rail] >= (LIMIT[rail] || 1)) { busySkipped[rail]++; return }
  const side = pickSide(pair), usd = pickUsd()
  inFlight[rail]++
  const t0 = now()
  trade(pair, rail, side, usd).then(
    (r) => record({ t: t0, pair: pair.key, rail, side, usd: Math.round(usd * 100) / 100, ok: true, ms: now() - t0, family: r.family }),
    (e) => record({ t: t0, pair: pair.key, rail, side, usd: Math.round(usd * 100) / 100, ok: false, ms: now() - t0, err: errText(e.message) }),
  ).finally(() => { inFlight[rail]-- })
}

// ---- the operator's finality (cfg.chain: its /v1/chain): while it waits on the Bitcoin anchor
// the in-tree rail makes no trade, and the ramp holds where it is, a pause and not a fault, never
// stepping back for it; the Lightning and on-chain rails, which need no Arca finality, trade on
let chainWait = null
async function readChain () {
  if (!cfg.chain) return
  try {
    const c = await (await fetch(cfg.chain, { signal: AbortSignal.timeout(10000) })).json()
    chainWait = ['anchor', 'anchor_status'].includes(c.waiting_on) ? `the Bitcoin anchor (at ${c.anchor_height} for ${Math.round((c.anchor_unchanged_seconds || 0) / 60)} min)` : null
  } catch { chainWait = null }
}

// the kernel's CPU pressure: the share (%) of the last minute some task waited for a CPU, or null
function cpuPressure () {
  try {
    const m = /some avg10=[\d.]+ avg60=([\d.]+)/.exec(fs.readFileSync('/proc/pressure/cpu', 'utf8'))
    return m ? Number(m[1]) : null
  } catch { return null }
}

// ---- the ramp's rules, over what happened lately
function rules () {
  const broken = []
  // The box is too busy when its tasks wait for a CPU: the kernel's CPU pressure, the share of the
  // last minute some task was ready and waiting. The load average counts every runnable task, a
  // build at nice 19 in a slice of two cores as much as a maker, so it holds the ramp for work
  // that yields to everything else; it is the rule only where the kernel keeps no pressure.
  const psi = cpuPressure()
  if (psi != null) {
    if (psi > RAMP.max_cpu_pressure) broken.push(`CPU pressure ${psi.toFixed(1)}% over ${RAMP.max_cpu_pressure}% (tasks waiting for a CPU, over the last minute)`)
  } else {
    const load = os.loadavg()[0], cores = os.cpus().length
    if (load > RAMP.max_load_share * cores) broken.push(`load ${load.toFixed(1)} over ${Math.round(RAMP.max_load_share * 100)}% of ${cores} cores`)
  }
  for (const rail of ['tree', 'pln', 'onchain']) {
    const last = trades.filter((x) => x.rail === rail).slice(-50)
    if (last.length >= 20) { const s = last.filter((x) => x.ok).length / last.length; if (s < RAMP.min_success) broken.push(`${rail} success ${(s * 100).toFixed(1)}%`) }
  }
  const tree = trades.filter((x) => x.rail === 'tree' && x.ok && x.t > now() - 15 * 60e3).map((x) => x.ms)
  const p95 = pct(tree, 0.95)
  if (tree.length >= 20 && p95 > RAMP.max_tree_p95_ms) broken.push(`in-tree p95 ${p95} ms`)
  if (chainWait) broken.push(`PAUSE (in-tree only): the operator's finality waits on ${chainWait}`)
  const lastProbes = probes.slice(-3).filter((x) => x.ok).map((x) => x.ms)
  if (probeBase != null && lastProbes.length && Math.min(...lastProbes) > probeBase + RAMP.max_probe_worse_ms) broken.push(`a wallet's trade ${Math.min(...lastProbes)} ms, ${probeBase} ms at the first step`)
  return broken
}
function rampTick () {
  const broken = rules()
  if (broken.length) {
    if (!holdReason) log('HOLD at step', step, `(${RAMP.steps[step]}):`, broken.join('; '))
    holdReason = broken.join('; '); cleanSince = now()
    const onlyPause = broken.every((b) => b.startsWith('PAUSE'))
    if (!onlyPause && step > 0 && now() - stepStarted > 10 * 60e3) { step--; stepStarted = now(); log('HOLD: back to step', step, `(${RAMP.steps[step]})`) }
    return
  }
  if (holdReason) { log('clear:', holdReason); holdReason = null }
  if (step < RAMP.steps.length - 1 && now() - stepStarted > RAMP.step_minutes * 60e3 && now() - cleanSince > RAMP.clean_minutes * 60e3) {
    step++; stepStarted = now(); cleanSince = now(); log('RAMP to step', step, `(${RAMP.steps[step]})`)
  }
}
async function probe () {
  const p = cfg.probe; if (!p) return
  if (chainWait) return   // the probe is an in-tree trade
  const t0 = now()
  try {
    const usd = p.usd || 20, side = probes.length % 2 ? 'sell' : 'buy'
    const b = ASSETS[p.base], q = ASSETS[p.quote]
    const [pay, receive, payT, payPx] = side === 'buy' ? [q.id, b.id, q, px(p.quote)] : [b.id, q.id, b, px(p.base)]
    if (!DRY) await walletTrade(p.wallet, pay, receive, Math.max(1, Math.round(usd / payPx * 10 ** payT.precision))); else await sleep(2500)
    probes.push({ t: t0, ok: true, ms: now() - t0 })
    if (step === 0 && probeBase == null) probeBase = now() - t0
  } catch (e) { probes.push({ t: t0, ok: false, ms: now() - t0, err: e.message }) }
}

function summary () {
  const day = now() - 86400e3, hour = now() - 3600e3
  const per = {}
  for (const x of trades) {
    if (x.t < day) continue
    const s = per[x.pair] ||= { usd24h: 0, trades24h: 0, failed24h: 0, usd1h: 0 }
    if (x.ok) { s.usd24h += x.usd; s.trades24h++; if (x.t > hour) s.usd1h += x.usd } else s.failed24h++
  }
  for (const s of Object.values(per)) { s.usd24h = Math.round(s.usd24h); s.usd1h = Math.round(s.usd1h); s.pace_per_day = s.usd1h * 24 }
  const rails = {}
  for (const rail of ['tree', 'pln', 'onchain']) {
    const r = trades.filter((x) => x.rail === rail && x.t > hour)
    const ok = r.filter((x) => x.ok)
    rails[rail] = { trades1h: r.length, success: r.length ? +(ok.length / r.length).toFixed(4) : null, p50_ms: pct(ok.map((x) => x.ms), 0.5), p95_ms: pct(ok.map((x) => x.ms), 0.95),
      busy_skipped: busySkipped[rail], in_flight: inFlight[rail], top_errors: topErrors(r) }
  }
  const s = { at: new Date().toISOString(), step, share: RAMP.steps[step], hold: holdReason, cpu_pressure: cpuPressure(), load: os.loadavg().map((x) => +x.toFixed(2)), cores: os.cpus().length,
    probe_ms: probes.slice(-3).map((x) => (x.ok ? x.ms : 'failed')), probe_base_ms: probeBase, pairs: per, rails,
    paused: chainWait, tree_skipped_paused: pausedSkipped, dry_run: DRY }
  fs.writeFileSync(path.join(STATE, 'summary.json'), JSON.stringify(s, null, 1))
  fs.writeFileSync(path.join(STATE, 'ramp.json'), JSON.stringify({ step, stepStarted, cleanSince, probeBase }))
  const tot = Object.values(per).reduce((a, x) => a + x.usd1h, 0)
  log(`step ${step} (${RAMP.steps[step]})${holdReason ? ' HOLD ' + holdReason : ''} | last hour $${tot.toLocaleString('en-US')} (pace $${(tot * 24).toLocaleString('en-US')}/day) | ` +
    Object.entries(rails).map(([k, v]) => `${k} ${v.trades1h} ok ${v.success ?? '-'} p95 ${v.p95_ms ?? '-'} busy ${v.busy_skipped}`).join(' | ') + ` | load ${s.load[0]}`)
}
// The commonest errors: alike ones counted together (long hex ids, which differ trade to trade,
// folded to <id>), each with its count and one message whole, as the trade recorded it.
function topErrors (r) {
  const c = {}
  for (const x of r) {
    if (x.ok) continue
    const raw = x.err || '?', k = raw.replace(/[0-9a-f]{16,}/gi, '<id>').slice(0, 300)
    c[k] = c[k] ? [c[k][0] + 1, c[k][1]] : [1, raw.slice(0, 300)]
  }
  return Object.entries(c).sort((a, b) => b[1][0] - a[1][0]).slice(0, 3).map(([k, [n, ex]]) => ({ error: k, count: n, example: ex }))
}

// ---- resume: what the last run reached, and the trades of the last day
try { const r = JSON.parse(fs.readFileSync(path.join(STATE, 'ramp.json'), 'utf8')); step = Math.min(r.step, RAMP.steps.length - 1); probeBase = r.probeBase } catch {}
try { for (const l of fs.readFileSync(tradesFile, 'utf8').split('\n')) { if (!l) continue; const x = JSON.parse(l); if (x.t > now() - 86400e3) trades.push(x) } } catch {}
stepStarted = now(); cleanSince = now()
log(`volume takers: ${PAIRS.length} pairs, $${cfg.usd_per_day_per_pair.toLocaleString('en-US')} a day each at full step, mean trade $${Math.round(meanSize)}, ` +
  `mix ${JSON.stringify(MIX)}, ${wallets.length} in-tree wallets, step ${step} (${RAMP.steps[step]})${DRY ? ', DRY RUN' : ''}`)

await readFeed()
await readChain()
setInterval(readFeed, 20000)
setInterval(readChain, 60000)
setInterval(summary, 60000)
setInterval(rampTick, 30000)
if (cfg.probe) { probe(); setInterval(probe, RAMP.probe_seconds * 1000) }
if (wallets.length && !DRY) setInterval(() => { for (const w of wallets) fetch(w.url + '/advance', { method: 'POST', body: '{}' }).catch(() => {}) }, 60000)
let stopping = false
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stopping = true; summary(); log('stopping: in-flight trades finish on their own'); setTimeout(() => process.exit(0), 2000) })
const TICK = 250
while (!stopping) {
  const share = RAMP.steps[step]
  for (const pair of PAIRS) {
    const target = (pair.usd_per_day ?? cfg.usd_per_day_per_pair) * share
    const lambda = target / meanSize / 86400   // trades a second
    if (Math.random() < lambda * TICK / 1000) launch(pair)
  }
  await sleep(TICK)
}
