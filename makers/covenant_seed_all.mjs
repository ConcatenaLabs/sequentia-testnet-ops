// covenant_seed_all.mjs - COVENANT ladder seeder for the 15 same-chain pairs.
// Replaces the ghost seeder (deep_seed_all.py): every level is a REAL tapscript
// passive-CLOB covenant order, funded on-chain from the covenant-seeder wallet,
// fillable permissionlessly while the maker is offline (the whole point).
// Idempotent: reconciles its state file + the chain + the relay book, reposts
// still-live offers after a relay restart (book is in RAM), relists unspent
// covenants whose offer TTL lapsed, and only funds NEW covenants for levels
// whose old outpoint was consumed (i.e. actually filled).
// Reuses the PRODUCTION wallet JS (byte-exact leaf/taptree/offer signing) from
// /root/sequentia/sequentia-web-wallet - the same code every live browser uses.
import { planPlaceOrder, buildCovenantTerms } from "/root/sequentia/sequentia-web-wallet/covenant-order.js";
import { computeRate, buildCovenantOffer } from "/root/sequentia/sequentia-web-wallet/covenant-flow.js";
import * as seqob from "/root/sequentia/sequentia-web-wallet/seqob.js";
import { secp256k1, schnorr } from "/root/sequentia/sequentia-web-wallet/btc.js";
import fs from "node:fs";
import crypto from "node:crypto";

const RELAY = "http://127.0.0.1:9955";
const FEED  = "http://127.0.0.1:8088/prices";
const RPCURL= "http://127.0.0.1:18300/";
const WALLET= "covenant-seeder";
const KEYSF = "/root/seqob-test/covenant-seeder-keys.json";
const STATEF= "/root/seqob-test/run/covenant-seeder-state.json";
const HRP   = "tb";
const COV_LOCKTIME_BLOCKS = 40000;   // refund-reclaimable after ~2-3 weeks
const OFFER_TTL_S = 167*3600;        // same as the old seeder ladder
const RELIST_MARGIN_S = 6*3600;      // relist when < 6h of offer TTL left

seqob.setSeqobBase(RELAY);

// Display-order asset ids (the book/pair convention; leaf wants them reversed).
const IDS = {
  SEQ:  "c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40",
  USDX: "2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de",
  EURX: "e39685e718516156679088d9400d11a1eb82bf7cc27c5b9f5a614b8c91246d13",
  GOLD: "3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1",
  SILVR:"57dfa6b0eff594cc3ef1de5555e0526d1eb5590289e014e7663b292edcd63f48",
  OILX: "4dfe69c334a9cdf4005ddf3889bba1bc397703fa8da669254877f3209caf7c8f",
};
const LABEL = { SEQ:"bitcoin", USDX:"USDX", EURX:"EURX", GOLD:"GOLD", SILVR:"SILVR", OILX:"OILX" };
const ORDER = ["SEQ","USDX","EURX","GOLD","SILVR","OILX"];
const revHex = h => Buffer.from(h,"hex").reverse().toString("hex");
const INTERNAL = Object.fromEntries(Object.entries(IDS).map(([k,v])=>[k,revHex(v)]));

// Ladder: USD notional per level, per SOLD asset (inventory-bound; treasury
// reissuance is impossible - tokens orphaned by the Jul-29 treasury2 recreation).
const LEVELS = {
  SEQ:   [55,59,64,69,75,81,87,94,102,110,119,128,138,150,162,174,188,204,220,237],
  USDX:  [30,32,35,38,41,44,48,51,56,60,65,70,76,82,88,95,103,111,120,129],
  EURX:  [33,36,38,42,45,48,52,57,61,66,71,77,83,90,97,105,113,122,132,142],
  GOLD:  [60,65,70,76,82,88,95,103,111,120,130,140,151,163,176,190,206,222,240,259],
  SILVR: [50,54,58,63,68,73,79,86,93,100,108,117,126,136,147,159,171,185,200,216],
  OILX:  [44,48,51,55,60,65,70,75,81,88,95,103,111,120,129,140,151,163,176,190],
};
// Distance of each level from the feed's mid: 30 bps at the touch, +25 bps a level, 5% at the
// twentieth. It ran to 30% before: a book whose asks sat 11% over the market on average, out to
// +60% once the price moved (21/10/2026). A covenant keeps the price it was funded at until its
// locktime, so only levels funded from now on take this scale.
const SPREADS = [0.003,0.0055,0.008,0.0105,0.013,0.0155,0.018,0.0205,0.023,0.0255,0.028,0.0305,0.033,0.0355,0.038,0.0405,0.043,0.0455,0.048,0.0505];
// Never spend the wallet below this floor of each asset (units).
const FLOOR = { SEQ: 150, USDX: 5, EURX: 5, GOLD: 0.01, SILVR: 0.5, OILX: 0.3 };


// ---------- covenant rate fitting ----------
// The covenant FILL leaf evaluates locked*rateNum + rateDen-1 in SIGNED 64-bit.
// computeRate only divides out the gcd, and two arbitrary atom counts are
// usually near-coprime, so rateNum stays ~recvAtoms and the product overflows on
// any large order. The relay rejects such an offer ("overflows the FILL leaf's
// signed 64-bit arithmetic") — and it did so AFTER this seeder had already
// broadcast the funding tx, stranding coins in a covenant nothing advertises.
// Snapping BOTH legs to a shared power-of-ten granularity forces gcd >= that
// granularity and shrinks rateNum by the same factor. Start at ~6 significant
// digits (price error < 1e-5, invisible at ladder resolution) and coarsen only
// if the bound still is not met. Returns null when nothing fits, so the caller
// can skip WITHOUT spending.
const I64MAX = (1n << 63n) - 1n;
function fitRate(sellAtoms, recvAtoms){
  const smallest = Math.min(sellAtoms, recvAtoms);
  let g = Math.pow(10, Math.max(0, Math.floor(Math.log10(smallest)) - 5));
  for (let i = 0; i < 9; i++, g *= 10){
    const sa = Math.max(g, Math.round(sellAtoms / g) * g);
    const ra = Math.max(g, Math.round(recvAtoms / g) * g);
    const rate = computeRate(BigInt(sa), BigInt(ra));
    if (BigInt(sa) * rate.rateNum + rate.rateDen - 1n <= I64MAX)
      return { sellAtoms: sa, recvAtoms: ra, rate };
  }
  return null;
}

// ---------- rpc ----------
// Credentials come from the NODE'S OWN config, never a literal. The box RPC
// password is rotated periodically; a stale literal turns every call into a
// silent 401 -> `getblockcount: null` -> this seeder dies inside the seqobd
// ExecStartPost hook -> the on-chain book loses ALL covenant depth, and nothing
// reports it. That is exactly how the book fell to 2 offers/pair (2026-08-23).
import { readFileSync as _readFileSync } from "node:fs";
const RPCAUTH = (() => {
  const conf = _readFileSync("/root/seq-testnet/node000/elements.conf", "utf8");
  const u = /^rpcuser=(.*)$/m.exec(conf), pw = /^rpcpassword=(.*)$/m.exec(conf);
  if (!u || !pw) throw new Error("no rpcuser/rpcpassword in elements.conf");
  return Buffer.from(u[1].trim() + ":" + pw[1].trim()).toString("base64");
})();
async function rpc(method, params=[], wallet){  // params: array (positional) or object (named)
  const r = await fetch(RPCURL + (wallet?`wallet/${wallet}`:""), { method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:"Basic "+RPCAUTH},
    body: JSON.stringify({jsonrpc:"1.0", id:"cs", method, params}) });
  const j = await r.json().catch(()=>null);
  if (!j || j.error) throw new Error(method+": "+JSON.stringify(j && j.error));
  return j.result;
}

// ---------- bech32m (BIP350) ----------
const B32C = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function b32polymod(v){ const G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3]; let chk=1;
  for (const x of v){ const b=chk>>25; chk=(chk&0x1ffffff)<<5^x; for(let i=0;i<5;i++) if((b>>i)&1) chk^=G[i]; } return chk; }
function b32hrpExpand(h){ const r=[]; for(const c of h) r.push(c.charCodeAt(0)>>5); r.push(0); for(const c of h) r.push(c.charCodeAt(0)&31); return r; }
function bech32mEncode(hrp, ver, prog){
  const conv=[]; let acc=0, bits=0;
  for (const b of prog){ acc=(acc<<8)|b; bits+=8; while(bits>=5){ bits-=5; conv.push((acc>>bits)&31); } }
  if (bits) conv.push((acc<<(5-bits))&31);
  const data=[ver, ...conv];
  const pm=b32polymod([...b32hrpExpand(hrp), ...data, 0,0,0,0,0,0]) ^ 0x2bc830a3;
  const cks=[]; for(let i=0;i<6;i++) cks.push((pm>>(5*(5-i)))&31);
  return hrp+"1"+[...data,...cks].map(d=>B32C[d]).join("");
}

// ---------- keys ----------
function loadKeys(){
  if (fs.existsSync(KEYSF)) return JSON.parse(fs.readFileSync(KEYSF,"utf8"));
  const k = { makerPriv: crypto.randomBytes(32).toString("hex"),
              payoutPriv: crypto.randomBytes(32).toString("hex") };
  fs.writeFileSync(KEYSF, JSON.stringify(k,null,1), {mode:0o600});
  return k;
}
const KEYS = loadKeys();
const h2b = h => Uint8Array.from(Buffer.from(h,"hex"));
const MPRIV = h2b(KEYS.makerPriv);
const makerPub = Buffer.from(secp256k1.getPublicKey(MPRIV, true)).toString("hex");
// Payout: a raw x-only key as the v1 witness program (proven shape - the regtest
// covenant tests use exactly this). Spendable key-path with payoutPriv.
const payoutX = Buffer.from(schnorr.getPublicKey(h2b(KEYS.payoutPriv))).toString("hex");

// ---------- state ----------
function loadState(){ try { return JSON.parse(fs.readFileSync(STATEF,"utf8")); } catch { return {orders:[]}; } }
function saveState(s){ fs.mkdirSync("/root/seqob-test/run",{recursive:true}); fs.writeFileSync(STATEF, JSON.stringify(s,null,1)); }

// ---------- book helpers (cross-guard) ----------
async function getBook(baseId, quoteId){
  try { const r=await fetch(`${RELAY}/v1/market/${baseId}/${quoteId}/orderbook`,{cache:"no-store"});
    const j=await r.json(); return j.offers||j.Offers||[]; } catch { return []; }
}
// best bid/ask for pair X/Y in Y-per-X units, from BOTH orientations.
async function bestPrices(X, Y){
  const fwd=await getBook(IDS[X],IDS[Y]), rev=await getBook(IDS[Y],IDS[X]);
  let bid=0, ask=Infinity;
  for (const o of fwd){
    const dir=o.trade_dir??o.tradeDir; const off=Number(o.offer_amount||o.offerAmount), want=Number(o.want_amount||o.wantAmount);
    if(!off||!want) continue;
    if (dir===1||dir==="TRADE_DIR_SELL"){ ask=Math.min(ask, want/off); }
    else if (dir===2||dir==="TRADE_DIR_BUY"){ bid=Math.max(bid, off/want); }
  }
  for (const o of rev){
    const dir=o.trade_dir??o.tradeDir; const off=Number(o.offer_amount||o.offerAmount), want=Number(o.want_amount||o.wantAmount);
    if(!off||!want) continue;
    if (dir===1||dir==="TRADE_DIR_SELL"){ bid=Math.max(bid, off/want); }       // sells Y for X = a bid on X/Y
    else if (dir===2||dir==="TRADE_DIR_BUY"){ ask=Math.min(ask, want/off); }
  }
  return {bid, ask};
}

// send with retry: unconfirmed-change chains can trip the mempool chain limit;
// wait a block and retry instead of dropping the level.
// Anchor reorgs WIPE the node mempool (Bitcoin anchoring is supreme; the chain
// follows Bitcoin in real time), which strands our unconfirmed change chain. On
// any send failure: rebroadcast our own unconfirmed sends, then wait a block.
async function rebroadcastUnconfirmed(wallet){
  const ts = await rpc("listtransactions",["*",50,0],wallet).catch(()=>[]);
  const seen=new Set();
  for (const t of ts){
    if (seen.has(t.txid) || t.category!=="send" || (t.confirmations??1)!==0) continue;
    seen.add(t.txid);
    try {
      const gt = await rpc("gettransaction",[t.txid],wallet);
      await rpc("sendrawtransaction",[gt.hex]);
      console.log("  rebroadcast "+t.txid.slice(0,12));
    } catch(e){ console.log("  rebroadcast "+t.txid.slice(0,12)+" failed: "+String(e.message||e).slice(0,60)); }
  }
}
async function sendRetry(args, wallet){
  for (let a=0;;a++){
    try { return await rpc("sendtoaddress", args, wallet); }
    catch(e){
      const m=String(e.message||e);
      if (a<10 && /chain|mempool|insufficient|missingorspent|unconf|fee/i.test(m)){
        console.log("  send retry ("+m.slice(0,80)+")");
        await rebroadcastUnconfirmed(wallet);
        await new Promise(r=>setTimeout(r,45000)); continue;
      }
      throw e;
    }
  }
}

// ---------- main ----------
const usd = {}; {
  const feed = await (await fetch(FEED)).json();
  for (const s of ORDER) usd[s] = Number(feed[s==="SEQ"?"SEQ":s].price);
}
const tip = await rpc("getblockcount");
const now = Math.floor(Date.now()/1000);
const state = loadState();
const alive = new Map();   // levelKey -> state order still live+listed
let removed=0, reposted=0, relisted=0, fundedNew=0, skipped=0, crossSkipped=0;

// 1) reconcile existing state
// live relay view of our own offers: a PARTIAL fill re-rests the remainder
// under the SAME offer_id at a NEW outpoint - adopt it instead of re-funding.
let mine = new Map();
try {
  const mj = await (await fetch(`${RELAY}/v1/offers?maker_pubkey=${makerPub}`)).json();
  for (const of_ of (mj.offers||mj.Offers||[])) mine.set(of_.offer_id||of_.offerId, of_);
} catch {}
const keep=[];
for (const o of state.orders){
  let txo = await rpc("gettxout",[o.covTxid, o.covVout, true]).catch(()=>null);
  if (!txo){
    const live = mine.get(o.signedOffer.offer_id);
    const lc = live && (live.covenant||live.Covenant);
    const ntxid = lc && (lc.covenant_txid||lc.covenantTxid);
    const nvout = lc ? Number(lc.covenant_vout??lc.covenantVout??0) : 0;
    if (ntxid && (ntxid!==o.covTxid || nvout!==o.covVout)){
      const ntxo = await rpc("gettxout",[ntxid,nvout,true]).catch(()=>null);
      if (ntxo){
        console.log(`REMAINDER-ADOPT ${o.levelKey} ${o.covTxid}:${o.covVout} -> ${ntxid}:${nvout}`);
        o.covTxid=ntxid; o.covVout=nvout;
        o.signedOffer.covenant.covenant_txid=ntxid; o.signedOffer.covenant.covenant_vout=nvout;
        o.sellAtoms=Math.round(Number(ntxo.value)*1e8);
        txo=ntxo;
      }
    }
  }
  if (!txo){ console.log(`FILLED/GONE ${o.levelKey} ${o.covTxid}:${o.covVout}`); removed++; continue; }
  if (o.expiryLocktime <= tip + 30){ console.log(`EXPIRING ${o.levelKey} (locktime ${o.expiryLocktime})`); removed++; continue; }
  const expLeft = Number(o.signedOffer.expires_at_unix) - now;
  if (expLeft < RELIST_MARGIN_S){
    // relist the SAME covenant under a fresh offer id + TTL
    const covenant = o.signedOffer.covenant;
    const offer = buildCovenantOffer({
      assetA: o.signedOffer.pair.base_asset, assetB: o.signedOffer.pair.quote_asset,
      sellAtoms: BigInt(o.signedOffer.base_amount), recvAtoms: BigInt(o.signedOffer.want_amount),
      covenant, makerPubkey: makerPub, recvAddress: "", offerId: crypto.randomBytes(16).toString("hex"),
      ttlSecs: OFFER_TTL_S, allowPartial: true, minLot: BigInt(o.signedOffer.min_lot||1),
    });
    const st = await seqob.postCovenantOffer(offer, MPRIV).catch(e=>({err:String(e)}));
    if (st.err){ console.log(`RELIST-FAIL ${o.levelKey}: ${st.err}`); removed++; continue; }
    o.signedOffer = offer; relisted++;
  } else {
    const st = await seqob.postCovenantOffer(o.signedOffer, MPRIV).catch(e=>({err:String(e)}));
    if (st.err && !/resting|exists/i.test(st.err)){ console.log(`REPOST-FAIL ${o.levelKey}: ${st.err}`); removed++; continue; }
    reposted++;
  }
  alive.set(o.levelKey, o); keep.push(o);
}
state.orders = keep;
saveState(state);

// 2) top up missing levels
const bal = await rpc("getbalances",[],WALLET).then(b=>b.mine.trusted);
const balOf = s => Number(bal[LABEL[s]==="bitcoin"?"bitcoin":LABEL[s]]||0);
const spent = Object.fromEntries(ORDER.map(s=>[s,0]));

for (let i=0;i<ORDER.length;i++) for (let j=i+1;j<ORDER.length;j++){
  const X=ORDER[i], Y=ORDER[j];
  const {bid,ask} = await bestPrices(X,Y);
  const mid = usd[X]/usd[Y];
  for (const side of ["ask","bid"]){
    const sellSym = side==="ask" ? X : Y, recvSym = side==="ask" ? Y : X;
    const plan = LEVELS[sellSym];
    for (let lvl=0; lvl<plan.length; lvl++){
      const key = `${X}_${Y}:${side}:${lvl}`;
      if (alive.has(key)) continue;
      const n = plan[lvl], sp = SPREADS[Math.min(lvl,SPREADS.length-1)];
      const price = side==="ask" ? mid*(1+sp) : mid*(1-sp);   // Y per X
      if (side==="ask" && bid>0 && price<=bid*1.001){ crossSkipped++; continue; }
      if (side==="bid" && isFinite(ask) && price>=ask*0.999){ crossSkipped++; continue; }
      const sellAtomsRaw = Math.max(1000, Math.round(n/usd[sellSym]*1e8));
      const recvAtomsRaw = side==="ask"
        ? Math.max(1, Math.round(n*(1+sp)/usd[Y]*1e8))
        : Math.max(1, Math.round(n/((1-sp))/usd[X]*1e8));
      // Fit the rate to the FILL leaf's 64-bit bound BEFORE spending anything.
      const fitted = fitRate(sellAtomsRaw, recvAtomsRaw);
      if (!fitted){
        console.log(`SKIP ${key}: no rate fits the FILL leaf 64-bit bound`); skipped++; continue;
      }
      const sellAtoms = fitted.sellAtoms, recvAtoms = fitted.recvAtoms;
      const unitsNeeded = sellAtoms/1e8;
      if (balOf(sellSym) - spent[sellSym] - unitsNeeded < FLOOR[sellSym]){
        console.log(`SKIP ${key}: ${sellSym} inventory floor`); skipped++; continue;
      }
      try {
        const rate = fitted.rate;
        const params = {
          assetA: INTERNAL[sellSym], assetB: INTERNAL[recvSym],
          sellAtoms: BigInt(sellAtoms), rateNum: rate.rateNum, rateDen: rate.rateDen,
          minLot: (BigInt(sellAtoms)/1000n)>0n ? (BigInt(sellAtoms)/1000n) : 1n,
          expiryLocktime: tip + COV_LOCKTIME_BLOCKS,
          makerProg: payoutX, makerX: payoutX,
        };
        const p = planPlaceOrder(params);
        const covAddr = bech32mEncode(HRP, 1, Buffer.from(p.spkHex.slice(4),"hex"));
        const va = await rpc("validateaddress",[covAddr]);
        if (!va.isvalid || va.witness_version!==1 || va.witness_program!==p.spkHex.slice(4))
          throw new Error("bech32m self-check failed");
        const amount = (sellAtoms/1e8).toFixed(8);
        const txid = await sendRetry({address:covAddr, amount:Number(amount), assetlabel:LABEL[sellSym], fee_asset_label:"bitcoin", fee_rate:2},WALLET);
        // resolve vout by spk
        const gt = await rpc("gettransaction",[txid],WALLET);
        const dec = await rpc("decoderawtransaction",[gt.hex]);
        let vout=-1; for (const o of dec.vout) if ((o.scriptPubKey&&o.scriptPubKey.hex||"").toLowerCase()===p.spkHex.toLowerCase()) vout=o.n;
        if (vout<0) throw new Error("covenant vout not found in "+txid);
        const covenant = buildCovenantTerms(p.order, txid, vout, p.tap);
        const offerId = crypto.randomBytes(16).toString("hex");
        const offer = buildCovenantOffer({
          assetA: IDS[sellSym], assetB: IDS[recvSym],
          sellAtoms: BigInt(sellAtoms), recvAtoms: BigInt(recvAtoms),
          covenant, makerPubkey: makerPub, recvAddress: "", offerId,
          ttlSecs: OFFER_TTL_S, allowPartial: true, minLot: params.minLot,
        });
        await seqob.postCovenantOffer(offer, MPRIV);
        spent[sellSym]+=unitsNeeded;
        const rec = { levelKey:key, sellSym, recvSym, sellAtoms, recvAtoms,
          covTxid:txid, covVout:vout, spkHex:p.spkHex, expiryLocktime:params.expiryLocktime,
          signedOffer:offer, createdUnix:now };
        state.orders.push(rec); alive.set(key, rec); saveState(state);
        fundedNew++;
        console.log(`SEEDED ${key} sell ${amount} ${sellSym} @ ${price.toFixed(6)} ${Y}/${X}  cov ${txid.slice(0,12)}:${vout}`);
      } catch(e){ console.log(`FAIL ${key}: ${e.message||e}`); skipped++; }
    }
  }
}

// 3) depth report
console.log("\n=== depth report (covenant offers per orientation) ===");
for (let i=0;i<ORDER.length;i++) for (let j=i+1;j<ORDER.length;j++){
  const X=ORDER[i], Y=ORDER[j];
  const fwd=await getBook(IDS[X],IDS[Y]), rev=await getBook(IDS[Y],IDS[X]);
  const cf=fwd.filter(o=>o.covenant||o.Covenant).length, cr=rev.filter(o=>o.covenant||o.Covenant).length;
  console.log(`${X}/${Y}: asks(cov)=${cf} bids(cov)=${cr}  (total fwd=${fwd.length} rev=${rev.length})`);
}
console.log(`\nsummary: reposted=${reposted} relisted=${relisted} removedFromState=${removed} fundedNew=${fundedNew} skipped=${skipped} crossSkipped=${crossSkipped}`);
