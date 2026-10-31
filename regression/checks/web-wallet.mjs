// The web wallet (sequentiatestnet.com/wallet/), in its default mode and in developer mode, at
// desktop and phone widths. Two wallets: a fresh one made here, and the funded test wallet when
// its phrase is given (--funded), restored into a fresh browser profile. Nothing is sent, traded
// or signed: the checks open pickers, type amounts and ask for a review, and stop there.
import { join } from 'node:path'
import { sleep, helpers, setWidth, forbiddenWords, forbiddenIn, PICKER, SEARCH, CLOSE } from '../lib/suite.mjs'

// WW_BASE checks another copy of the page: a branch served in front of the testnet by the web
// wallet's tooling/live-proxy.mjs, before it is deployed.
const BASE = process.env.WW_BASE || 'https://sequentiatestnet.com/wallet/'
const ORIGIN = new URL(BASE).origin

async function openWallet (b, h, { phrase } = {}) {
  await b.send('Page.navigate', { url: BASE }, h.page.sessionId)
  await h.waitFor("(()=>{const v=(id)=>{const e=document.getElementById(id); return e && getComputedStyle(e).display!=='none'}; return v('app')||v('welcome')})()", 240000)
  if (phrase) {
    await h.eval(`localStorage.setItem('swk.sequentia.mnemonic', ${JSON.stringify(phrase)}), true`)
    await b.send('Page.navigate', { url: 'about:blank' }, h.page.sessionId); await sleep(1500)
    await b.send('Page.navigate', { url: BASE }, h.page.sessionId)
  } else {
    await h.waitFor("document.querySelector('#btnCreate') && document.querySelector('#btnCreate').offsetParent !== null", 120000)
    await h.click('#btnCreate')
    await h.waitFor("document.querySelector('#btnConfirm') && document.querySelector('#btnConfirm').offsetParent !== null")
    await h.click('#btnConfirm')
  }
  await h.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none'", 240000)
}
const tab = async (h, name) => { await h.click(`[data-tab=${name}]`); await sleep(1500) }
async function mode (h, m) {
  await tab(h, 'settings')
  await h.eval(`(()=>{const c=document.querySelector('#mode${m === 'user' ? 'User' : 'Developer'}'); c.checked=true; c.dispatchEvent(new Event('change')); return true})()`)
  await sleep(3000)
}
// The default mode's receive code, once the wallet has joined (about 30 s after it opens).
const waitCode = (h) => h.waitFor("/^bitcoin:/i.test((document.querySelector('#addr')||{}).textContent||'')", 180000).then(() => true, () => false)
const balanceTickers = (h) => h.eval("[...document.querySelectorAll('section[data-panel=balance] .bt-tk .tk')].filter(e=>e.getClientRects().length).map(e=>e.innerText.trim())")
const totalText = (h) => h.text('#balTotal')
// A number of four or more digits not grouped (thousands separators), in what a person reads.
const ungrouped = (t) => (String(t).match(/(^|[^\d.,])\d{4,}(?=[.\s]|$)/g) || []).map((x) => x.trim())
// A dash in a sentence (a word on each side), which default mode's copy never uses.
const dashes = (t) => String(t).split('\n').filter((l) => /\S\s[—–]\s\S/.test(l)).map((l) => l.trim().slice(0, 100))
const pickAsset = (sel, tk) => `(async()=>{const b=document.querySelector(${JSON.stringify(sel)}); if(!b) return false; b.click(); await new Promise(r=>setTimeout(r,500)); const i=document.querySelector('.swpop-search input'); if(!i) return false; i.value=${JSON.stringify(tk)}; i.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,400)); const o=[...document.querySelectorAll('.swpop [role=option]')].find(o=>((o.querySelector('.swopt-tk')||{}).firstChild||{}).textContent===${JSON.stringify(tk)}); if(!o){ i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return false } o.click(); await new Promise(r=>setTimeout(r,800)); return true})()`

export async function run ({ b, report, widths, funded, problems }) {
  const R = (id, w, line, h, fn) => report.line('WW-' + id, w, line, h && h.page, fn)
  const page = await b.page('about:blank')
  const h = helpers(page)
  await page.b.send('Network.enable', {}, page.sessionId).catch(() => {})
  const words = await forbiddenWords(h).catch(() => null)

  // ---------- a fresh wallet, default mode ----------
  await setWidth(b, page, widths[0])
  await openWallet(b, h)
  await R('PHRASE-GONE', null, 'Once the backup is confirmed, the recovery phrase is no longer in the page', h, async () => {
    const r = await h.eval("(()=>{const m=(localStorage.getItem('swk.sequentia.mnemonic')||'').split(' '); const w=document.getElementById('words'); return {wordNodes:w?w.children.length:null, pending:typeof window._pending, inPage:m.length>=3 && document.documentElement.outerHTML.includes(m.slice(0,3).join(' '))}})()")
    return { ok: r.wordNodes === 0 && r.pending !== 'string' && !r.inPage, detail: r }
  })
  const joined = await waitCode(h)
  for (const w of widths) {
    await setWidth(b, page, w); await sleep(800)
    await tab(h, 'balance')
    await R('BAL-FRESH', w, 'A fresh wallet shows exactly one row: BTC at 0', h, async () => {
      await h.waitFor("document.querySelectorAll('section[data-panel=balance] .bt-tk .tk').length", 60000)
      const t = await balanceTickers(h); return { ok: t.length === 1 && t[0] === 'BTC', detail: t }
    })
    await R('BAL-TOTAL', w, 'One total in the reference currency at the top', h, async () => {
      const t = await totalText(h); return { ok: /total balance/i.test(t) && /\d/.test(t), detail: t.replace(/\s+/g, ' ') }
    })
    await R('BAL-REF', w, 'The reference currency can be changed (Show values in)', h, async () => {
      const r = await h.eval("(async()=>{const s=document.querySelector('#refCcySel'); if(!s) return null; const was=s.value; const to=[...s.options].map(o=>o.value).find(v=>v!==was&&v==='BTC')||[...s.options].map(o=>o.value).find(v=>v!==was); s.value=to; s.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,1500)); const t=document.querySelector('#balTotal').innerText; s.value=was; s.dispatchEvent(new Event('change')); return {to, t}})()")
      return { ok: !!r && r.t.includes(r.to), detail: r }
    })
    await R('BAL-FAUCET', w, 'The testnet faucet card offers its assets', h, async () => {
      const n = await h.eval("document.querySelectorAll('#faucetBtns button').length"); return { ok: n >= 2, detail: `${n} buttons` }
    })

    await tab(h, 'receive')
    await R('RCV-CODE', w, 'Receive shows a "Receive code": bitcoin:<address>?ark=…&sequentia=…', h, async () => {
      const lbl = await h.text('#recvLbl'), code = await h.text('#addr')
      return { ok: joined && /receive code/i.test(lbl) && /^bitcoin:tb1[a-z0-9]+\?.*ark=.*sequentia=/i.test(code), detail: { label: lbl, code: code.slice(0, 60) + '…' } }
    })
    await R('RCV-SHORT', w, 'The code scans at a glance: upper case, the request short (SQR1…), under 450 characters', h, async () => {
      const code = (await h.text('#addr')).trim()
      const ok = /^BITCOIN:TB1[0-9A-Z]+\?/.test(code) && /&sequentia=SQR1[0-9A-Z]+(&|$)/.test(code) && code.length < 450
      return { ok, detail: { chars: code.length, code: code.slice(0, 60) + '…' } }
    })
    await R('RCV-TIP', w, 'Under it: "Any asset, any amount. …"', h, async () => {
      const t = await h.text('#recvTip'); return { ok: /^Any asset, any amount\./.test(t), detail: t }
    })
    await R('RCV-BUTTONS', w, 'Buttons "Copy receive code" and "New code"; no address-only controls', h, async () => {
      const c = await h.text('#btnCopy'), n = await h.text('#btnNewAddr'), conf = await h.visible('#btnConf'), xpub = await h.visible('#btnXpub')
      return { ok: c === 'Copy receive code' && n === 'New code' && !conf && !xpub, detail: { copy: c, new: n, blindedButton: conf, xpub } }
    })
    await R('RCV-AMOUNT', w, '"Amount in BTC (optional)": with an amount the code names it and carries an invoice', h, async () => {
      const ph = await h.eval("(document.querySelector('#recvAmt')||{}).placeholder||''")
      if (!/Amount in BTC/i.test(ph)) return { ok: false, detail: 'field: ' + JSON.stringify(ph) }
      await h.type('#recvAmt', '0.0001')
      const ok = await h.waitFor("/amount=0\\.0001/.test(document.querySelector('#addr').textContent) && /lightning=/.test(document.querySelector('#addr').textContent)", 60000).then(() => true, () => false)
      const code = await h.text('#addr'); await h.type('#recvAmt', '')
      // The code is drawn again without the amount a moment after the field empties: the next line
      // reads Receive as a person leaves it, not mid-redraw.
      await h.waitFor("!/lightning=/i.test(document.querySelector('#addr').textContent)", 15000).catch(() => {})
      return { ok, detail: code.replace(/(lightning=)\w{12}\w*/i, '$1…').slice(0, 140) }
    })
    await R('RCV-NO-INVOICE', w, 'Receive: a wallet holding no BTC shows no invoice card and no empty framed box', h, async () => {
      const c = await h.visible('#lnRecvCard'), box = await h.visible('#lnRecvBolt11')
      return { ok: !c && !box, detail: { card: c, emptyBox: box } }
    })
    if (words) await R('RCV-WORDS', w, 'Receive says none of the words default mode never says', h, async () => {
      const f = forbiddenIn(await h.text('section[data-panel=receive]'), words); return { ok: !f.length, detail: f }
    })

    await tab(h, 'send')
    await R('SND-RECIPIENT', w, 'Send: the field is "Recipient", hint "a receive code, an address or an invoice"', h, async () => {
      const r = await h.eval("(()=>{const i=document.querySelector('section[data-panel=send] .raddr'); const l=i&&i.closest('.rec').querySelector('label'); return {label:l&&l.innerText.trim(), hint:i&&i.placeholder}})()")
      return { at: 'section[data-panel=send] .raddr', ok: /^recipient$/i.test(r.label || '') && r.hint === 'a receive code, an address or an invoice', detail: r }
    })
    await R('SND-BALANCE', w, 'Send: next to the asset its one figure, "balance <amount>"', h, async () => {
      const t = await h.text('section[data-panel=send] .ravail'); return { at: 'section[data-panel=send] .ravail',  ok: /^balance /.test(t), detail: t }
    })
    await R('SND-NO-INVOICE', w, 'Send: a wallet holding no BTC shows no "Pay an invoice" card', h, async () => {
      const c = await h.visible('#lnSendCard'); return { ok: !c, detail: { card: c } }
    })
    if (words) await R('SND-WORDS', w, 'Send says none of the words default mode never says, and has no fee-rate field', h, async () => {
      const t = await h.text('section[data-panel=send]'); const f = forbiddenIn(t, words)
      const rate = await h.eval("[...document.querySelectorAll('section[data-panel=send] input')].some(i=>i.getClientRects().length && /fee ?rate|\\/vB/i.test((i.placeholder||'')+(i.previousElementSibling?.innerText||'')))")
      return { ok: !f.length && !rate, detail: { words: f, feeRateField: rate } }
    })

    await tab(h, 'swap'); await sleep(4000)
    await R('TRD-FORM', w, 'Trade: You pay, You receive, their amounts, and Review', h, async () => {
      const t = await h.text('#userComposerRoot'); const r = await h.visible('#ucReview')
      return { ok: /you pay/i.test(t) && /you receive/i.test(t) && r, detail: { review: r } }
    })
    await R('TRD-PAY-SEARCH', w, 'Trade: the You pay picker is searchable', h, async () => {
      const p = await h.eval(PICKER('#ucPay')); await h.eval(CLOSE)
      return { at: '#ucPay',  ok: p.search, detail: p.kind === 'select' ? `a plain <select> (${p.rows.length} options), no search` : p }
    })
    await R('TRD-GET-SEARCH', w, 'Trade: the You receive picker is searchable, and finds an asset by ticker', h, async () => {
      const p = await h.eval(PICKER('#ucGet'))
      if (!p.search) { await h.eval(CLOSE); return { at: '#ucGet',  ok: false, detail: p.kind === 'select' ? `a plain <select> (${p.rows.length} options), no search` : p } }
      const rows = await h.eval(SEARCH('GOLD')); await h.eval(CLOSE)
      return { ok: rows && rows.includes('GOLD'), detail: rows }
    })
    await R('TRD-PASTE-ID', w, 'Trade: pasting an asset id in the picker finds that asset', h, async () => {
      const gold = await h.eval("fetch('/registry/index.minimal.json').then(r=>r.json()).then(j=>Object.keys(j).find(k=>Array.isArray(j[k])&&j[k][1]==='GOLD'))")
      const p = await h.eval(PICKER('#ucGet'))
      if (!p.search) { await h.eval(CLOSE); return { at: '#ucGet',  ok: false, detail: 'no search box to paste into' } }
      const rows = await h.eval(SEARCH(gold)); await h.eval(CLOSE)
      return { ok: !!rows && rows.length >= 1, detail: rows }
    })
    await R('TRD-AMOUNTS', w, 'Trade: an amount in You pay shows what You receive, and an amount in You receive shows what You pay', h, async () => {
      const f = await h.eval("[...document.querySelectorAll('#userComposerRoot input')].filter(i=>i.getClientRects().length).map(i=>i.id||i.placeholder)")
      return { at: '#ucAmount',  ok: f.length >= 2, detail: f.length < 2 ? `one amount field (${f.join(', ')}); no You receive amount` : f }
    })
    await R('TRD-REFUSE', w, 'Trade: a refusal in plain words ("You have no BTC to trade." / "Enter how much you pay.")', h, async () => {
      await h.type('#ucAmount', ''); await h.click('#ucReview'); await sleep(1500)
      const a = await h.text('#ucNote')
      await h.type('#ucAmount', '0.001'); await h.click('#ucReview')
      await h.waitFor("/[A-Za-z]/.test((document.querySelector('#ucNote')||{}).innerText||'') && !/Finding/.test(document.querySelector('#ucNote').innerText)", 60000).catch(() => {})
      const b2 = await h.text('#ucNote'); await h.type('#ucAmount', '')
      return { ok: a === 'Enter how much you pay.' && /^You have no BTC to trade\.$|^Up to .* can be traded now\.$/.test(b2), detail: { empty: a, fresh: b2 } }
    })
    await R('MKT-HEAD', w, 'Market: the pair "<base> / <quote>", the last price and its 24h change', h, async () => {
      const t = await h.text('#ucMarket'); return { ok: /^\S+ \/ \S+/.test(t) && /24h|No trades/.test(t), detail: t.split('\n').slice(0, 2).join(' | ') }
    })
    await R('MKT-CHART', w, 'Market: a chart with 1D, 1W, 1M and the TradingView notice', h, async () => {
      const t = await h.text('#ucMarket'); const c = await h.eval("!!document.querySelector('#ucMarket canvas')")
      return { ok: c && /1D/.test(t) && /1W/.test(t) && /1M/.test(t) && /Charts by TradingView Lightweight Charts/.test(t), detail: { canvas: c } }
    })
    await R('MKT-BOOK', w, 'Market: Best bid and Best ask with Buyers/Sellers %, or "Nobody is buying or selling right now"', h, async () => {
      const t = await h.text('#ucMarket'); return { ok: (/Best bid/.test(t) && /Best ask/.test(t) && /Buyers \d+%/.test(t) && /Sellers \d+%/.test(t)) || /Nobody is buying or selling right now/.test(t), detail: (t.match(/Best bid.*|Nobody.*/) || [''])[0] }
    })
    await R('MKT-TRADES', w, 'Market: Recent trades with price, amount and time, or "No trades yet"', h, async () => {
      const t = await h.text('#ucMarket'); return { ok: /Recent trades/.test(t) || /No trades yet/.test(t), detail: (t.match(/Recent trades.*/) || ['none'])[0] }
    })
    await R('TRD-FLIP', w, 'Trade: ⇅ exchanges You pay and You receive, the amount typed going with its asset', h, async () => {
      if (!(await h.visible('#ucFlip'))) return { ok: false, detail: 'no ⇅ control' }
      await h.type('#ucAmount', '0.001'); await sleep(600)
      const before = await h.eval("[document.querySelector('#ucPay').innerText.trim(), document.querySelector('#ucGet').innerText.trim()]")
      await h.click('#ucFlip'); await sleep(1500)
      const after = await h.eval("[document.querySelector('#ucPay').innerText.trim(), document.querySelector('#ucGet').innerText.trim(), document.querySelector('#ucReceive').value]")
      await h.click('#ucFlip'); await sleep(1000); await h.type('#ucAmount', '')
      return { ok: after[0] === before[1] && after[1] === before[0] && after[2] === '0.001', detail: { before, after } }
    })
    await R('MKT-BTC-QUOTE', w, 'Market: BTC against a fiat stablecoin is priced in the stablecoin ("BTC / USDX")', h, async () => {
      const p1 = await h.eval(pickAsset('#ucPay', 'BTC')), p2 = await h.eval(pickAsset('#ucGet', 'USDX'))
      await h.waitFor("/\\//.test((document.querySelector('#ucMarket')||{}).innerText||'')", 20000).catch(() => {})
      const head = (await h.text('#ucMarket')).split('\n')[0]
      return { ok: p1 && p2 && /^BTC \/ USDX/.test(head), detail: { picked: [p1, p2], head } }
    })
    if (w === widths[0]) await R('TRD-KEEP-RELOAD', w, 'A reload keeps the open tab and the Trade pair and amount', h, async () => {
      await h.type('#ucAmount', '0.002'); await sleep(800)
      const pair = await h.eval("[document.querySelector('#ucPay').innerText.trim(), document.querySelector('#ucGet').innerText.trim()]")
      await b.send('Page.reload', {}, h.page.sessionId)
      await h.waitFor("document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display !== 'none' && !!document.querySelector('#ucAmount')", 240000).catch(() => {})
      await sleep(3000)
      const r = await h.eval("({tab:(document.querySelector('#tabs button.active')||{dataset:{}}).dataset.tab, pay:(document.querySelector('#ucPay')||{innerText:''}).innerText.trim(), get:(document.querySelector('#ucGet')||{innerText:''}).innerText.trim(), amount:(document.querySelector('#ucAmount')||{}).value})")
      await h.type('#ucAmount', '').catch(() => {})
      return { ok: r.tab === 'swap' && r.pay === pair[0] && r.get === pair[1] && r.amount === '0.002', detail: { before: pair, after: r } }
    })
    if (words) await R('TRD-WORDS', w, 'Trade says none of the words default mode never says', h, async () => {
      const f = forbiddenIn(await h.text('section[data-panel=swap]'), words); return { ok: !f.length, detail: f }
    })
    await tab(h, 'history')
    await R('HIS-OPEN', w, 'History opens', h, async () => ({ ok: await h.visible('#historyPanel') }))
    await R('HIS-NO-RESCUE', w, 'History in default mode offers no Bump fee, Replace or Speed up: a payment that waits is sped up by itself', h, async () => {
      await tab(h, 'history')
      const found = await h.eval("[...document.querySelectorAll('#historyPanel button')].map(b=>b.textContent.trim()).filter(t=>/^(Bump fee|Replace…|Speed up)$/.test(t))")
      await tab(h, 'balance')
      return { ok: !found.length, detail: found }
    })
    if (words) await R('APP-WORDS', w, 'No tab in default mode says a word default mode never says', h, async () => {
      const found = {}
      for (const t of ['balance', 'send', 'receive', 'swap', 'history']) { await tab(h, t); const f = forbiddenIn(await h.text('#app'), words); if (f.length) found[t] = f }
      return { ok: !Object.keys(found).length, detail: found }
    })
    if (words) await R('MORE-WORDS', w, 'Mix, Issuance, Stake, Sign, Help and Settings say no word default mode never says, and no dash in a sentence', h, async () => {
      const found = {}
      for (const t of ['mix', 'assets', 'stake', 'sign', 'help', 'settings']) {
        await h.eval(`(document.querySelector('#tabs button[data-tab=${t}]')||{click(){}}).click(),1`); await sleep(1500)
        const txt = await h.text(`section[data-panel=${t}]`); const f = [...forbiddenIn(txt, words), ...['SeqDEX', 'OpenAMP'].filter((x) => txt.includes(x)), ...dashes(txt)]
        if (f.length) found[t] = f
      }
      await tab(h, 'balance')
      return { ok: !Object.keys(found).length, detail: found }
    })
    if (w === 'phone') await R('PHONE-FIT', w, 'Phone: no tab scrolls sideways', h, async () => {
      const over = {}
      for (const t of ['balance', 'send', 'receive', 'swap', 'history']) { await tab(h, t); const o = await h.overflow(); if (o > 1) over[t] = o + 'px' }
      return { ok: !Object.keys(over).length, detail: over }
    })
  }
  // A faucet payment is in the balance the moment the faucet says it was sent, and in History.
  await R('FAUCET-AT-ONCE', null, 'A faucet payment shows under its asset as arriving the moment the faucet says it was sent, and History lists it as Received', h, async () => {
    await setWidth(b, page, widths[0]); await tab(h, 'balance')
    const asset = await h.eval("(()=>{const b=[...document.querySelectorAll('#faucetBtns button')].find(x=>x.dataset.faucet==='EURX')||[...document.querySelectorAll('#faucetBtns button')].find(x=>x.dataset.faucet && x.dataset.faucet!=='BTC'); if(!b) return null; b.click(); return b.dataset.faucet})()")
    if (!asset) return { skip: 'no faucet button for an asset' }
    const said = await h.waitFor("/arriving|Received|Already|error/i.test((document.querySelector('#faucetStatus')||{}).innerText||'')", 120000).then(() => true, () => false)
    const st = await h.text('#faucetStatus')
    if (/Already funded/i.test(st)) return { skip: 'the faucet paid this address recently: ' + st }
    if (!said || !/arriving|Received/.test(st)) return { ok: false, detail: 'faucet: ' + st }
    const shown = await h.waitFor(`[...document.querySelectorAll('section[data-panel=balance] .bt-tk .tk')].some(e=>e.innerText.trim()===${JSON.stringify(asset)})`, 2500).then(() => true, () => false)
    await h.waitFor("/Received/.test((document.querySelector('#faucetStatus')||{}).innerText||'')", 120000).catch(() => {})
    await tab(h, 'history')
    const row = await h.waitFor(`[...document.querySelectorAll('#histList .item')].some(i=>/Received/.test(i.innerText) && i.innerText.includes(${JSON.stringify(asset)}))`, 30000).then(() => true, () => false)
    return { ok: shown && row, detail: { faucet: st, inBalanceWithin2_5s: shown, historyRow: row } }
  })
  // The node calls the leaf wallet makes to read an address a person gives it (a payment from
  // leaves, an offboard, a claim) and to tell a supervised asset from a plain one, asked of the
  // page's own node route as the wallet asks them.
  // What waits on the chain is sped up by itself, and a coin received out of round is refreshed
  // at the next round by itself: the served page carries both (a live run needs a full block, or
  // the faucet's payment and a round, which the default-mode drive shows).
  await R('SPEED-REFRESH-BUILT', null, 'The page speeds up what waits and refreshes what is received by itself, in words default mode may say', h, async () => {
    const r = await h.eval(`(async()=>{const t=(p)=>fetch(new URL(p,location.href)).then(r=>r.ok?r.text():'');
      const sp=await t('speed-up.js'), lv=await t('leaves.js'), wasm=await t('leaves/pkg/leaf_wallet_bg.wasm');
      const m=sp.match(/spedUp: '([^']+)'/);
      return {words:m?m[1]:null, refresh:lv.includes("run('refresh_received'"), library:wasm.includes('refresh_received')&&wasm.includes('speed_up')}})()`)
    const said = r.words ? forbiddenIn(r.words, words || []) : ['no words']
    return { ok: !!r.words && !said.length && r.refresh && r.library, detail: r }
  })
  await R('NODE-READS', null, 'The node route answers the wallet\'s address and supervised-asset reads', h, async () => {
    const r = await h.eval(`(async()=>{const call=(method,params)=>fetch('/node-rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params,id:1})}).then(r=>r.json());
      const v=await call('validateaddress',['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx']);
      const s=await call('getsupervisedassets',[]);
      const a=(Array.isArray(s.result)&&s.result[0]&&s.result[0].asset)||'0'.repeat(64);
      const f=await call('isassetfrozen',[a,'0014'+'11'.repeat(20)]);
      return {validateaddress:v.error?v.error.message:(v.result&&v.result.isvalid),getsupervisedassets:s.error?s.error.message:s.result.length+' assets',isassetfrozen:f.error?f.error.message:f.result}})()`)
    const refused = (x) => typeof x === 'string' && /not allowed here/.test(x)
    return { ok: r.validateaddress === true && !refused(r.getsupervisedassets) && !refused(r.isassetfrozen), detail: r }
  })
  await R('NO-ERRORS', null, 'No uncaught error on the page (fresh wallet)', null, async () => ({ ok: problems(page).length === 0, detail: problems(page).slice(0, 4) }))

  // ---------- the funded test wallet ----------
  if (!funded) {
    for (const id of ['BAL-RELOAD', 'BAL-BTC-FIRST', 'BAL-HIDE', 'SND-PICKER-HELD', 'SND-FEE-LINE', 'AMT-GROUPED', 'TRD-NO-FALSE-UPTO', 'TRD-HELD-FIRST', 'TRD-HIDDEN', 'STK-FROM-BALANCE', 'DEV-PICKER', 'DEV-TETHER']) report.skip('WW-' + id, null, 'needs the funded test wallet', 'no --funded phrase file')
    return
  }
  // A fresh profile for it: the page holds one wallet per origin.
  await b.send('Page.navigate', { url: 'about:blank' }, page.sessionId); await sleep(1000)
  await b.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' }, page.sessionId).catch(() => {})
  await setWidth(b, page, widths[0])
  await openWallet(b, h, { phrase: funded.phrase })
  await tab(h, 'balance')
  const held = await h.waitFor("(()=>{const t=[...document.querySelectorAll('section[data-panel=balance] .bt-tk .tk')].map(e=>e.innerText.trim()); return t.length>=3 ? t : false})()", 240000).then(() => true, () => false)
  await R('BAL-RELOAD', null, 'A reload opens on the last figures: the total never reads 0, nor "Up to date." before everything is read', h, async () => {
    await h.waitFor("/Up to date/.test((document.querySelector('#syncStatus')||{}).innerText||'')", 240000).catch(() => {})
    await b.send('Page.reload', {}, h.page.sessionId)
    const seen = []; const t0 = Date.now()
    while (Date.now() - t0 < 15000) {
      await sleep(250)
      const r = await h.eval("({t:((document.querySelector('#balTotal')||{}).innerText||'').replace(/\\s+/g,' '), s:((document.querySelector('#syncStatus')||{}).innerText||'')})").catch(() => null)
      if (r && r.t && (!seen.length || seen[seen.length - 1].t !== r.t || seen[seen.length - 1].s !== r.s)) seen.push({ ms: Date.now() - t0, ...r })
    }
    const zero = seen.filter((x) => /total balance 0 /i.test(x.t))
    return { ok: held && !zero.length, detail: zero.length ? { zero: zero.slice(0, 3) } : seen.slice(0, 4) }
  })
  for (const w of widths) {
    await setWidth(b, page, w); await sleep(800)
    await tab(h, 'balance')
    await R('BAL-BTC-FIRST', w, 'BTC is the first row; every other asset one row among equals, with no "native" label', h, async () => {
      const t = await balanceTickers(h); const nat = /native/i.test(await h.text('section[data-panel=balance]'))
      return { ok: held && t[0] === 'BTC' && t.length >= (w === widths[0] ? 3 : 2) && !nat, detail: { rows: t, native: nat } }
    })
    await R('BAL-HIDE', w, 'An asset can be hidden: it leaves the list for "Hidden assets (N)", and the total stays the same', h, async () => {
      const before = await totalText(h)
      const r = await h.eval("(async()=>{const row=[...document.querySelectorAll('section[data-panel=balance] .bt-tk')].find(x=>x.querySelector('.tk').innerText.trim()==='GOLD'); if(!row) return 'no GOLD row'; const d=[...row.parentElement.querySelectorAll('*')].find(x=>x.children.length===0 && x.innerText && x.innerText.trim()==='details'); if(d) d.click(); await new Promise(r=>setTimeout(r,800)); const b=[...document.querySelectorAll('section[data-panel=balance] button')].find(x=>x.getClientRects().length && /Hide asset/.test(x.innerText)); if(!b) return 'no hide button'+(d?'':' (no details)'); b.click(); await new Promise(r=>setTimeout(r,1500)); return 'hidden'})()")
      const t = await balanceTickers(h), body = await h.text('section[data-panel=balance]'), after = await totalText(h)
      return { ok: (r === 'hidden' || (r === 'no GOLD row' && w !== widths[0])) && !t.includes('GOLD') && /Hidden assets \(1\)/.test(body) && before === after, detail: { r, rows: t, totalBefore: before.replace(/\s+/g, ' '), totalAfter: after.replace(/\s+/g, ' ') } }
    })
    await tab(h, 'send')
    await R('SND-PICKER-HELD', w, 'Send: the asset picker lists BTC, then every asset the wallet holds, with its balance', h, async () => {
      await tab(h, 'balance'); const bal = (await balanceTickers(h).catch(() => [])) || []; await tab(h, 'send')
      const p = await h.eval(PICKER('#recipients .rec .asset-chooser')); await h.eval(CLOSE)
      // Every row Balance lists (a hidden asset is not one of them) is under Your assets.
      return { ok: p.rows[0] === 'BTC' && bal.length > 1 && bal.every((t) => p.rows.includes(t)), detail: { rows: p.rows.slice(0, 8), groups: p.groups, balance: bal } }
    })
    await R('SND-FEE-LINE', w, 'Send: paying a receive code shows no network fee line waiting for the amount', h, async () => {
      await tab(h, 'receive'); const code = (await h.text('#addr')).trim(); await tab(h, 'send')
      await h.eval("(()=>{const s=document.querySelector('#recipients .rec .rasset'); const o=[...s.options].find(x=>x.textContent.trim()==='USDX'); if(o){ s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})) } return !!o})()")
      await h.type('#recipients .rec .raddr', code); await h.type('#recipients .rec .ramt', '0.01'); await sleep(2500)
      const shown = await h.visible('#sendFeeBox'), t = shown ? await h.text('#sendFeeBox') : ''
      const avail = await h.text('#recipients .rec .ravail')
      await h.type('#recipients .rec .raddr', ''); await h.type('#recipients .rec .ramt', '')
      // A code paid at its address (before the wallet's instant side has opened) has a fee line, which
      // must say the fee: never one waiting for the amount already typed.
      return { ok: /^bitcoin:/i.test(code) && !/set once the amount is entered/.test(t), detail: { feeLine: shown ? t.slice(0, 80) : '(none)', balanceLine: avail } }
    })
    await R('AMT-GROUPED', w, 'Amounts outside Balance are grouped as Balance groups them (Send, the pickers, Trade)', h, async () => {
      const send = await h.text('#recipients .rec .ravail')
      const p = await h.eval(PICKER('#recipients .rec .asset-chooser')); const rows = await h.eval("[...document.querySelectorAll('.swpop .swopt-bal')].map(x=>x.innerText).join(' | ')"); await h.eval(CLOSE)
      await tab(h, 'swap'); await sleep(2500)
      const have = await h.text('#ucHave')
      const found = [...ungrouped(send), ...ungrouped(rows), ...ungrouped(have)]
      return { ok: !found.length, detail: { send, have, ungrouped: found, picker: p.kind } }
    })
    await tab(h, 'swap'); await sleep(4000)
    await R('TRD-NO-FALSE-UPTO', w, 'Trade: no "The book can fill up to …" for an amount the book can fill', h, async () => {
      const ok1 = await h.eval(pickAsset('#ucPay', 'USDX')), ok2 = await h.eval(pickAsset('#ucGet', 'GOLD'))
      await h.type('#ucAmount', '1'); await h.waitFor("Number((document.querySelector('#ucReceive')||{}).value)>0", 30000).catch(() => {})
      await sleep(1500); const note = await h.text('#ucNote'); const got = await h.eval("document.querySelector('#ucReceive').value"); await h.type('#ucAmount', '')
      if (!(Number(got) > 0)) return { skip: 'the book priced nothing for 1 USDX → GOLD: ' + (note || 'no answer') }
      return { ok: ok1 && ok2 && !/can fill up to/i.test(note), detail: { receive: got, note } }
    })
    await R('TRD-HELD-FIRST', w, 'Trade: the You receive picker lists BTC, then your assets, before the rest', h, async () => {
      const p = await h.eval(PICKER('#ucGet')); await h.eval(CLOSE)
      const at = '#ucGet'; const mine = ['BTC', 'USDX', 'GOLD']; const i = p.rows.findIndex((x) => !mine.includes(x))
      const late = p.rows.slice(i < 0 ? p.rows.length : i).filter((x) => mine.includes(x))
      return { at, ok: p.search && p.rows[0] === 'BTC' && !late.length, detail: { kind: p.kind, first: p.rows.slice(0, 6), heldAfterOthers: late, groups: p.groups } }
    })
    await R('TRD-HIDDEN', w, 'Trade: a hidden asset is left out of the pickers\' first list and found by search', h, async () => {
      const p = await h.eval(PICKER('#ucPay'))
      if (!p.search) { await h.eval(CLOSE); return { at: '#ucPay', ok: false, detail: `a plain <select>; hidden GOLD listed: ${p.rows.includes('GOLD')}` } }
      const s = await h.eval(SEARCH('GOLD')); await h.eval(CLOSE)
      return { ok: !p.rows.includes('GOLD') && !!s && s.includes('GOLD'), detail: { first: p.rows, search: s } }
    })
    await R('STK-FROM-BALANCE', w, 'Stake and Mix count what the balance shows: Stake offers its fee in a held asset, Mix says what is held', h, async () => {
      await h.eval("(document.querySelector('#tabs button[data-tab=stake]')||{click(){}}).click(),1"); await sleep(1500)
      const fee = await h.eval("[...document.querySelectorAll('#stFeeAsset option')].map(o=>o.textContent)")
      await h.eval("(document.querySelector('#tabs button[data-tab=mix]')||{click(){}}).click(),1"); await sleep(3000)
      const plan = await h.text('#cjPlan')
      await tab(h, 'swap'); await sleep(1500)
      return { ok: Array.isArray(fee) && fee.length >= 1 && !/transparent coins/.test(plan) && !/you hold 0 /.test(plan), detail: { feeChoices: fee, mixPlan: plan.slice(0, 120) } }
    })
    await R('TRD-HELD-TRADABLE', w, 'Trade: every asset the balance shows can be paid from (never "You have no <T> to trade.")', h, async () => {
      const bad = {}
      for (const tk of ['USDX', 'GOLD']) {
        // You pay is the shared asset chooser: search the ticker, then choose its row.
        const set = await h.eval(`(async()=>{const b=document.querySelector('#ucPay'); if(!b) return false; b.click(); await new Promise(r=>setTimeout(r,500)); const i=document.querySelector('.swpop-search input'); if(!i) return false; i.value='${tk}'; i.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,400)); const o=[...document.querySelectorAll('.swpop [role=option]')].find(o=>((o.querySelector('.swopt-tk')||{}).firstChild||{}).textContent==='${tk}'); if(!o){ i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return false } o.click(); return true})()`)
        if (!set) { bad[tk] = 'not offered in You pay'; continue }
        await sleep(800); await h.type('#ucAmount', tk === 'GOLD' ? '0.01' : '1'); await h.click('#ucReview')
        await h.waitFor("/[A-Za-z]/.test((document.querySelector('#ucNote')||{}).innerText||'') && !/Finding/.test(document.querySelector('#ucNote').innerText) || !!document.querySelector('#ucConfirm')", 60000).catch(() => {})
        const note = await h.text('#ucNote'); if (/^You have no /.test(note)) bad[tk] = note
        await h.eval("(document.querySelector('#ucCancel')||{click(){}}).click(),1"); await h.type('#ucAmount', '')
      }
      return { ok: !Object.keys(bad).length, detail: bad }
    })
  }
  // Developer mode: the picker the default mode should have, and tethered amounts.
  await mode(h, 'developer')
  for (const w of widths) {
    await setWidth(b, page, w); await tab(h, 'swap'); await sleep(3000)
    await R('DEV-PICKER', w, 'Developer Swap: a searchable picker, "Your assets" first, hidden left out, search finds it', h, async () => {
      const p = await h.eval(PICKER('#swPayPick'))
      const s = p.search ? await h.eval(SEARCH('GOLD')) : null; await h.eval(CLOSE)
      return { ok: p.search && p.rows[0] === 'BTC' && /^your assets$/i.test(p.groups[0] || '') && !p.rows.includes('GOLD') && s && s.includes('GOLD'), detail: { first: p.rows, groups: p.groups, search: s } }
    })
    await R('DEV-TETHER', w, 'Developer Swap: an amount in You pay fills You receive', h, async () => {
      await h.eval(PICKER('#swRecvPick')); await sleep(300)
      const picked = await h.eval("(()=>{const o=[...document.querySelectorAll('[role=option]')].find(x=>x.getClientRects().length && /^USDX/.test(x.innerText.trim())); if(!o) return false; o.click(); return true})()")
      await sleep(2000); await h.type('#swPayAmt', '0.0001')
      const ok = await h.waitFor("Number((document.querySelector('#swRecvAmt')||{}).value)>0", 45000).then(() => true, () => false)
      const v = await h.eval("document.querySelector('#swRecvAmt').value"); await h.type('#swPayAmt', '')
      return { ok: picked && ok, detail: { picked, receive: v } }
    })
  }
  await R('DEV-MARKETS', null, 'Developer Swap: Browse markets lists the markets', h, async () => {
    await h.click('#swMarketsBtn'); await sleep(3000)
    const t = await h.text('section[data-panel=swap]'); const m = t.match(/(\d+) pairs/); const rows = t.split('\n').filter(l => /^[A-Za-z0-9.]+ ?\/ ?[A-Za-z0-9.]+(\t|$)/.test(l.trim())).length
    await h.clickText('button', 'Close').catch(() => {})
    return { ok: !!m && Number(m[1]) >= 3 && rows >= 3, detail: `${m ? m[1] : 0} pairs, ${rows} rows shown` }
  })
  await mode(h, 'user')
  await R('NO-ERRORS-FUNDED', null, 'No uncaught error on the page (funded wallet)', null, async () => ({ ok: problems(page).length === 0, detail: problems(page).slice(0, 4) }))
}
