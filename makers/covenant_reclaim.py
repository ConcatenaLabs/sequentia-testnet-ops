#!/usr/bin/env python3
"""Reclaim the covenant ladder's expired orders: the REFUND leaf, after the lock.

covenant_seed_all.mjs funds each level of the on-chain ladder as a covenant that
anyone may fill at its price and that only the maker may take back, through the
REFUND leaf, once the chain passes its expiry height. The seeder used to drop an
expiring order from its state and fund a new level, and nothing took the old
coins back: they stayed locked for good. It now moves such an order to
`expired` in its state file and runs this script at the end of every pass.

For each expired order whose lock has passed and whose covenant output is still
unspent, this builds the refund the regtest proof builds
(seqdex test/regtest/feature_seqob_covenant_fill.py, build_refund): the
covenant as the only input, the locked asset back to the seeder wallet minus
the network fee, paid in that same asset. It rebuilds the order's taproot tree
from the terms the order was advertised with and refuses to sign unless it
gives the covenant's own scriptPubKey. An order whose output is spent (filled,
or reclaimed on an earlier pass and confirmed) leaves the state and is written
to run/covenant-reclaimed.jsonl.

    covenant_reclaim.py [--dry-run] [--state FILE]

Paths: SEQDEX_DIR (seqdex checkout, for seqob_covenant.py) and SEQUENTIA_DIR
(node checkout, for test_framework) default to the box's.
"""
import argparse
import base64
import json
import math
import os
import sys
import time
import urllib.request

SEQDEX_DIR = os.environ.get('SEQDEX_DIR', '/root/sequentia/seqdex')
SEQUENTIA_DIR = os.environ.get('SEQUENTIA_DIR', '/root/sequentia/Sequentia')
sys.path.insert(0, os.path.join(SEQDEX_DIR, 'test', 'regtest'))
sys.path.insert(0, os.path.join(SEQUENTIA_DIR, 'test', 'functional'))

import seqob_covenant as cov  # noqa: E402
from test_framework.key import sign_schnorr  # noqa: E402
from test_framework.messages import (  # noqa: E402
    COutPoint, CTransaction, CTxIn, CTxInWitness, CTxOut, CTxOutAsset,
    CTxOutValue, CTxOutWitness, uint256_from_str,
)
from test_framework.script import TaprootSignatureHash  # noqa: E402

STATEF = '/root/seqob-test/run/covenant-seeder-state.json'
LOGF = '/root/seqob-test/run/covenant-reclaimed.jsonl'
KEYSF = '/root/seqob-test/covenant-seeder-keys.json'
CONF = '/root/seq-testnet/node000/elements.conf'
RPCURL = 'http://127.0.0.1:18300/'
WALLET = 'covenant-seeder'
# The fee, in reference atoms: about 250 vB at 4 atoms/vB, priced into the asset
# reclaimed at the node's exchange rate. Twice the relay floor and more.
FEE_REF_ATOMS = 1000


def rpc(method, params=None, wallet=None):
    conf = open(CONF).read()
    user = next(l.split('=', 1)[1].strip() for l in conf.splitlines() if l.startswith('rpcuser='))
    pw = next(l.split('=', 1)[1].strip() for l in conf.splitlines() if l.startswith('rpcpassword='))
    req = urllib.request.Request(RPCURL + (f'wallet/{wallet}' if wallet else ''),
                                 data=json.dumps({'jsonrpc': '1.0', 'id': 'reclaim', 'method': method, 'params': params or []}).encode(),
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': 'Basic ' + base64.b64encode(f'{user}:{pw}'.encode()).decode()})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        r = json.load(e)
    if r.get('error'):
        raise RuntimeError(f"{method}: {r['error'].get('message')}")
    return r['result']


def h(s):
    return bytes.fromhex(s)


def fee_atoms(asset_display):
    """The fee in the reclaimed asset's own atoms, from the node's exchange rate."""
    labels = rpc('dumpassetlabels')
    label = next((k for k, v in labels.items() if v == asset_display), None)
    rates = rpc('getfeeexchangerates')
    rate = rates.get(label) or rates.get(asset_display)
    if not rate:
        raise RuntimeError(f'the node prices no fee in {asset_display[:8]}')
    return max(1, math.ceil(FEE_REF_ATOMS * 1e8 / rate))


def taptree(c):
    """The order's taproot tree, from the terms it was advertised with (internal byte order)."""
    tap, fill, refund = cov.order_taptree(
        h(c['asset_a']), h(c['asset_b']), int(c['rate_num']), int(c['rate_den']),
        h(c['maker_prog']), int(c['min_lot']), int(c['expiry_locktime']), h(c['maker_x']),
        h(c['internal_key']))
    return tap, refund


def build_refund(order, payout_sec, genesis, reclaim_spk):
    c = order['signedOffer']['covenant']
    tap, refund = taptree(c)
    spk = bytes(tap.scriptPubKey)
    if spk.hex() != order['spkHex']:
        raise RuntimeError(f"the rebuilt tree gives {spk.hex()[:16]}…, not the covenant's {order['spkHex'][:16]}…")
    txo = rpc('gettxout', [order['covTxid'], order['covVout'], True])
    if not txo:
        return None
    locked = round(txo['value'] * 1e8)
    asset_display = txo['asset']
    asset_out = b'\x01' + h(asset_display)[::-1]
    fee = fee_atoms(asset_display)
    if locked <= fee:
        raise RuntimeError(f'{locked} atoms locked do not cover the {fee}-atom fee')
    tx = CTransaction()
    tx.nVersion = 2
    tx.nLockTime = int(c['expiry_locktime'])
    tx.vin.append(CTxIn(COutPoint(int(order['covTxid'], 16), order['covVout']), nSequence=0xfffffffe))
    tx.vout.append(CTxOut(nValue=CTxOutValue(locked - fee), scriptPubKey=reclaim_spk, nAsset=CTxOutAsset(asset_out)))
    tx.vout.append(CTxOut(nValue=CTxOutValue(fee), nAsset=CTxOutAsset(asset_out)))
    spent = [CTxOut(nValue=CTxOutValue(locked), scriptPubKey=spk, nAsset=CTxOutAsset(asset_out))]
    # The Elements taproot sighash commits to one (empty) witness per input and output.
    while len(tx.wit.vtxinwit) < len(tx.vin):
        tx.wit.vtxinwit.append(CTxInWitness())
    while len(tx.wit.vtxoutwit) < len(tx.vout):
        tx.wit.vtxoutwit.append(CTxOutWitness())
    msg = TaprootSignatureHash(tx, spent, 0, genesis, 0, scriptpath=True, script=refund)
    sig = sign_schnorr(payout_sec, msg)
    tx.wit.vtxinwit[0].scriptWitness.stack = cov.refund_witness(tap, refund, sig)
    return tx, locked, fee, asset_display


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='build and test each refund, broadcast nothing')
    ap.add_argument('--state', default=STATEF)
    args = ap.parse_args()

    state = json.load(open(args.state))
    expired = state.get('expired', [])
    if not expired:
        print('reclaim: no expired orders')
        return
    payout_sec = h(json.load(open(KEYSF))['payoutPriv'])
    tip = rpc('getblockcount')
    genesis = uint256_from_str(h(rpc('getblockhash', [0]))[::-1])
    keep, done = [], []
    for o in expired:
        key = f"{o['levelKey']} {o['covTxid'][:12]}:{o['covVout']}"
        expiry = int(o['signedOffer']['covenant']['expiry_locktime'])
        if tip < expiry:
            keep.append(o)
            continue
        txo = rpc('gettxout', [o['covTxid'], o['covVout'], True])
        if not txo:
            print(f'reclaim: {key} is spent ({"reclaimed " + o["reclaimTxid"][:12] if o.get("reclaimTxid") else "filled"})')
            done.append({**{k: o[k] for k in ('levelKey', 'covTxid', 'covVout', 'sellSym', 'sellAtoms')},
                         'reclaimTxid': o.get('reclaimTxid'), 'at': int(time.time())})
            continue
        try:
            addr = o.get('reclaimAddr') or rpc('getnewaddress', ['covenant-reclaim', 'bech32'], WALLET)
            info = rpc('getaddressinfo', [addr], WALLET)
            reclaim_spk = h(info['scriptPubKey'])
            tx, locked, fee, asset = build_refund(o, payout_sec, genesis, reclaim_spk)
            raw = tx.serialize().hex()
            test = rpc('testmempoolaccept', [[raw]])[0]
            if not test.get('allowed'):
                raise RuntimeError(test.get('reject-reason') or json.dumps(test))
            if args.dry_run:
                print(f'reclaim: {key} would return {locked - fee} of {asset[:8]} (fee {fee}): accepted')
                keep.append(o)
                continue
            txid = rpc('sendrawtransaction', [raw])
            o['reclaimTxid'], o['reclaimAddr'] = txid, addr
            print(f'reclaim: {key} returned {locked - fee} of {asset[:8]} (fee {fee}) in {txid}')
        except Exception as e:
            print(f'reclaim: {key} failed: {e}')
        keep.append(o)
    if not args.dry_run:
        state['expired'] = keep
        tmp = args.state + '.tmp'
        json.dump(state, open(tmp, 'w'), indent=1)
        os.replace(tmp, args.state)
        with open(LOGF, 'a') as f:
            for d in done:
                f.write(json.dumps(d) + '\n')
    print(f'reclaim: {len(done)} settled, {len(keep)} still waiting')


if __name__ == '__main__':
    main()
