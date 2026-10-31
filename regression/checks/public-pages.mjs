// The public pages around the web wallet, at desktop and phone widths: the front page, the faucet
// page, Compages, the explorer (in a light colour scheme too), the staking pools, the Sequentia Core
// download and Emissio's report scopes. Each line reads a page as a new tester meets it. Nothing
// is requested, bridged or sent: the faucet's and Compages' lines check that a receive code is
// taken, and stop before any button that would move coins.
import { sleep, helpers, setWidth } from '../lib/suite.mjs'

const SITE = process.env.SITE_URL || 'https://sequentiatestnet.com'
// A receive code as the web wallet writes it (sequentia-web-wallet pay-code.js): upper case, its
// address the BIP173 testnet vector, which every node takes as a valid tb1 address.
const ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const CODE = 'BITCOIN:' + ADDR.toUpperCase() + '?ark=TARK1PNGLPCR3ZQQPQRP6TLZTDFMCHLYN76TQVXHG8XGUSPYMP8HG4F0JF445AQ3YZ4P3ZQYPEJS78MQ2CTZC8RZMDCCLKA7J4FE273DLXS87UD70ZV3KXDZVL9NQ3YWVYE&sequentia=SQR1QQQQ'
// Paths and names of products that are served but not public: public copy never links or names them.
const HIDDEN_PATHS = /href="(\/dex|\/lending|\/levo|\/seqpal|\/liquidity|\/secretfullmenu|\/download\/")/
const HIDDEN_NAMES = /\b(Ambra|SeqDEX|Pignus|Levo|SeqPal|Fulmen)\b/

// Visible text drawn near-white on a light background (its own or the nearest painted ancestor's).
const WHITE_ON_LIGHT = `(()=>{
  const lum=c=>{const m=c.match(/[\\d.]+/g); if(!m) return null; const [r,g,b,a=1]=m.map(Number); return a<0.1?null:(0.299*r+0.587*g+0.114*b)};
  const bg=el=>{for(let e=el;e;e=e.parentElement){const l=lum(getComputedStyle(e).backgroundColor); if(l!==null) return l} return 255};
  const out=[];
  for(const el of document.querySelectorAll('body *')){
    if(!el.getClientRects().length) continue;
    if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())) continue;
    if(lum(getComputedStyle(el).color)>200 && bg(el)>200) out.push((el.className||el.tagName)+': '+el.textContent.trim().slice(0,30));
  }
  return [...new Set(out)].slice(0,8);
})()`

export async function run ({ b, report, widths }) {
  const page = await b.page('about:blank')
  const h = helpers(page)
  const R = (id, w, line, fn) => report.line('PP-' + id, w, line, page, fn)
  const go = async (url, ready, ms = 45000) => { await b.send('Page.navigate', { url }, page.sessionId); await h.waitFor(ready, ms); await sleep(800) }
  const scheme = (value) => b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] }, page.sessionId)

  await R('FCT-BTC-AMT', null, 'The faucet says what a BTC request pays, more than nothing', async () => {
    const r = await fetch(SITE + '/faucet/amount?asset=BTC').then((x) => x.json())
    return { ok: r.asset === 'BTC' && Number(r.amount) > 0, detail: r }
  })

  for (const w of widths) {
    await setWidth(b, page, w)
    await scheme('dark')

    await go(SITE + '/', "document.querySelector('.card')")
    await R('LAND-START', w, 'The front page leads with the network\'s one line and one step to start: the web wallet', async () => {
      const t = await h.bodyText()
      const start = await h.eval("(()=>{const s=document.querySelector('.start a'); return s ? s.getAttribute('href') : null})()")
      const first = await h.eval("(document.querySelector('.grid .card h2')||{}).innerText||''")
      const over = await h.overflow()
      return { ok: /A Bitcoin sidechain for asset tokenization and disintermediated exchanges/.test(t) && start === '/wallet/' && /^Web Wallet/.test(first) && over <= 1,
        detail: { start, first, overflow: over }, at: '.start' }
    })
    await R('LAND-PUBLIC', w, 'The front page names and links public products only, in plain words', async () => {
      const html = await h.eval('document.body.innerHTML'), t = await h.bodyText()
      const bad = [(html.match(HIDDEN_PATHS) || [])[0], (t.match(HIDDEN_NAMES) || [])[0], (t.match(/\b(Lightning|BLS|on chain or)\b/) || [])[0]].filter(Boolean)
      return { ok: !bad.length, detail: bad.length ? bad : 'clean' }
    })

    await go(SITE + '/faucet', "document.querySelector('#addr')")
    await R('FCT-CODE', w, 'The faucet page takes the web wallet\'s receive code, and offers BTC', async () => {
      await h.type('#addr', CODE)
      const taken = await h.eval('typeof checkAddr==="function" && checkAddr()===' + JSON.stringify(CODE))
      const btc = await h.visible('button[data-asset="BTC"]')
      await page.eval("localStorage.removeItem('faucetAddr'); document.getElementById('addr').value=''; true")
      return { ok: taken && btc, detail: { code_taken: taken, btc_button: btc }, at: '#addr' }
    })

    await go(SITE + '/bridge/', "document.querySelector('#seqaddr-input')")
    await R('CMP-CODE', w, 'Compages takes a receive code where it asks for a Sequentia address, and reads its address', async () => {
      await h.type('#seqaddr-input', CODE)
      let msg = ''
      for (let i = 0; i < 40 && !/^Valid|not a valid|could not/.test(msg); i++) { await sleep(250); msg = await h.text('#seqaddr-input-check') }
      const v = await h.eval("document.getElementById('seqaddr-input').value")
      return { ok: v === ADDR && /^Valid Sequentia address/.test(msg), detail: { field: v, says: msg }, at: '#seqaddr-input' }
    })

    await scheme('light')
    for (const [id, path, ready] of [['EXP-LIGHT', '/explorer/', "document.querySelector('.block-stat-value')"], ['EXP-LIGHT-ASSETS', '/explorer/assets', "document.querySelector('.assets-table-row')"]]) {
      await go(SITE + path, ready)
      await sleep(1500)
      await R(id, w, `In a light colour scheme, no text on ${path} is white on a light background`, async () => {
        const bad = await h.eval(WHITE_ON_LIGHT)
        return { ok: !bad.length, detail: bad.length ? bad : 'none' }
      })
    }
    await R('EXP-ASSETS', w, 'The Assets page opens on the registered assets, with no "None" in place of a ticker or domain', async () => {
      const reg = await h.eval("document.querySelectorAll('.asset-list-registered .assets-table-row').length")
      const firstTicker = await h.text('.asset-list-registered .assets-table-row .asset-list-ticker')
      const none = await h.eval("[...document.querySelectorAll('.assets-table-row em')].filter(e=>e.innerText.trim()==='None').length")
      return { ok: reg > 0 && !!firstTicker && none === 0, detail: { registered: reg, first_ticker: firstTicker, none } }
    })
    await scheme('dark')

    await go(SITE + '/pools/', "document.querySelector('#stats') && document.querySelector('#stats').innerText.length > 0")
    await R('POOLS', w, 'The pools page gives stakes in tSEQ and offers delegation from the web wallet first', async () => {
      const stats = await h.text('#stats'), t = await h.bodyText()
      const over = await h.overflow()
      return { ok: /tSEQ/.test(stats) && !/\d SEQ\b/.test(t) && /From the web wallet/.test(t) && /More → Stake/.test(t) && over <= 1,
        detail: { stats: stats.replace(/\s+/g, ' ').slice(0, 80), overflow: over } }
    })

    await go(SITE + '/download/core/', "document.querySelector('.card')")
    await R('CORE-MAC', w, 'The Core download page gives a Mac user a path: the web wallet, or a build from source', async () => {
      const links = await h.eval("[...document.querySelectorAll('#mac a')].map(a=>a.getAttribute('href'))")
      const t = await h.bodyText()
      return { ok: links.includes('/wallet/') && links.some((l) => /build-osx/.test(l)) && !/rather than/.test(t), detail: links, at: '#mac' }
    })
  }

  for (const [id, path] of [['EMI-BUGS', '/emissio/bugs'], ['EMI-SECURITY', '/emissio/security']]) {
    await go(SITE + path, "document.querySelector('.lede')")
    await R(id, null, `Emissio's ${path.split('/').pop()} scope names the web wallet`, async () => {
      const t = await h.text('.lede')
      return { ok: /web wallet/i.test(t), detail: t.slice(0, 160) }
    })
  }
}
