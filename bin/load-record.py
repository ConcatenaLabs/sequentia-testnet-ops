#!/usr/bin/env python3
"""load-record.py: the box's load history, one line every five minutes (box-load-record.timer).

Each run appends one JSON line to the record (default /var/log/box-load/load.jsonl): the load
average, the kernel's pressure (cpu, io, memory), how the CPU time since the previous run divided
(user, nice, system, iowait, steal, idle), the processes started a second, the memory available,
and the CPU, memory and process count of every systemd unit that used at least half a percent of
one core since the previous run, from the unit's own cgroup, so the CPU of short-lived processes a
unit starts counts as that unit's. The state between runs is one small file beside the record.

    load-record.py                       # record one line (the timer's job)
    load-record.py --report [HOURS]      # the last HOURS (default 24) of the record, an hour a line
    load-record.py --report 6 --units 8  # with the top 8 units of each hour

Reads only /proc and /sys/fs/cgroup; writes only the record and its state file.
"""
import json
import os
import sys
import time

RECORD = os.environ.get('LOAD_RECORD', '/var/log/box-load/load.jsonl')
STATE = os.environ.get('LOAD_RECORD_STATE', os.path.join(os.path.dirname(RECORD), 'state.json'))
CGROOT = os.environ.get('LOAD_RECORD_CGROUP', '/sys/fs/cgroup')
MIN_SHARE = 0.5   # percent of one core


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def units():
    """Every top-level unit cgroup: system.slice/*.service and *.scope (one level of sub-slices,
    for template instances), user sessions' scopes and user@.service, and init.scope."""
    out = {}

    def walk(path, depth):
        try:
            entries = os.listdir(os.path.join(CGROOT, path))
        except OSError:
            return
        for e in entries:
            p = os.path.join(path, e)
            if not os.path.isdir(os.path.join(CGROOT, p)):
                continue
            if e.endswith('.service') or e.endswith('.scope'):
                out[e] = p
            elif e.endswith('.slice') and depth < 3:
                walk(p, depth + 1)

    walk('', 0)
    return out


def usage(path):
    s = read(os.path.join(CGROOT, path, 'cpu.stat')) or ''
    for line in s.splitlines():
        k, _, v = line.partition(' ')
        if k == 'usage_usec':
            return int(v)
    return None


def nprocs(path):
    s = read(os.path.join(CGROOT, path, 'cgroup.procs'))
    n = len(s.split()) if s else 0
    try:
        for e in os.listdir(os.path.join(CGROOT, path)):
            if os.path.isdir(os.path.join(CGROOT, path, e)):
                n += nprocs(os.path.join(path, e))
    except OSError:
        pass
    return n


def pressure(name):
    s = read(f'/proc/pressure/{name}')
    if not s:
        return None
    f = dict(kv.split('=') for kv in s.splitlines()[0].split()[1:])
    return float(f['avg300'])


def record():
    now = time.time()
    stat = {}
    for line in (read('/proc/stat') or '').splitlines():
        f = line.split()
        if f and f[0] == 'cpu':
            stat['cpu'] = [int(x) for x in f[1:9]]
        elif f and f[0] == 'processes':
            stat['processes'] = int(f[1])
    paths = units()
    us = {u: usage(p) for u, p in paths.items()}
    try:
        prev = json.loads(read(STATE) or '{}')
    except ValueError:
        prev = {}
    line = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)), 'cores': os.cpu_count(),
            'load': [float(x) for x in (read('/proc/loadavg') or '0 0 0').split()[:3]],
            'pressure_avg300': {n: pressure(n) for n in ('cpu', 'io', 'memory')}}
    mem = dict((l.split(':')[0], int(l.split()[1]) * 1024) for l in (read('/proc/meminfo') or '').splitlines() if l.split())
    line['mem_available_gib'] = round(mem.get('MemAvailable', 0) / 2**30, 1)
    line['swap_used_gib'] = round((mem.get('SwapTotal', 0) - mem.get('SwapFree', 0)) / 2**30, 1)
    dt = now - prev.get('t', 0)
    if prev and 0 < dt < 3600:
        d = [b - a for a, b in zip(prev['cpu'], stat['cpu'])]
        tot = sum(d) or 1
        names = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal']
        line['seconds'] = round(dt)
        line['cpu_pct'] = {n: round(d[i] / tot * 100, 1) for i, n in enumerate(names)}
        line['busy_cores'] = round((tot - d[3] - d[4]) / tot * os.cpu_count(), 2)
        line['forks_per_s'] = round((stat['processes'] - prev['processes']) / dt, 1)
        rows = []
        for u, v in us.items():
            a = prev['units'].get(u)
            if v is None or a is None or v < a:
                continue
            share = (v - a) / 1e6 / dt * 100
            if share >= MIN_SHARE:
                p = paths.get(u)
                m = read(os.path.join(CGROOT, p, 'memory.current')) if p else None
                rows.append([u, round(share, 1), nprocs(p) if p else 0, round(int(m) / 2**20) if m else None])
        rows.sort(key=lambda r: -r[1])
        line['units'] = rows   # [unit, CPU % of one core, processes, memory MiB]
    os.makedirs(os.path.dirname(RECORD), exist_ok=True)
    with open(RECORD, 'a') as f:
        f.write(json.dumps(line, separators=(',', ':')) + '\n')
    tmp = STATE + '.next'
    with open(tmp, 'w') as f:
        json.dump({'t': now, 'cpu': stat['cpu'], 'processes': stat['processes'], 'units': us}, f)
    os.replace(tmp, STATE)


def report(hours, k):
    since = time.time() - hours * 3600
    by = {}
    paths = [RECORD + '.1', RECORD] if os.path.exists(RECORD + '.1') else [RECORD]
    for path in paths:
        for raw in (read(path) or '').splitlines():
            try:
                r = json.loads(raw)
            except ValueError:
                continue
            t = time.mktime(time.strptime(r['at'], '%Y-%m-%dT%H:%M:%SZ')) - time.timezone
            if t < since or 'busy_cores' not in r:
                continue
            by.setdefault(r['at'][:13], []).append(r)
    print(f'{"hour (UTC)":13} {"load1":>6} {"busy":>5} {"iowait":>6} {"steal":>5} {"cpu psi":>7} {"forks/s":>7}  top units (% of one core)')
    for h in sorted(by):
        rs = by[h]
        avg = lambda f: sum(f(r) for r in rs) / len(rs)
        u = {}
        for r in rs:
            for name, share, *_ in r.get('units', []):
                u[name] = u.get(name, 0) + share / len(rs)
        top = ', '.join(f'{n.replace(".service", "")} {v:.0f}' for n, v in sorted(u.items(), key=lambda kv: -kv[1])[:k])
        print(f'{h.replace("T", " "):13} {avg(lambda r: r["load"][0]):6.1f} {avg(lambda r: r["busy_cores"]):5.1f} '
              f'{avg(lambda r: r["cpu_pct"]["iowait"]):5.1f}% {avg(lambda r: r["cpu_pct"]["steal"]):4.1f}% '
              f'{avg(lambda r: (r["pressure_avg300"].get("cpu") or 0)):6.1f}% {avg(lambda r: r["forks_per_s"]):7.0f}  {top}')


if __name__ == '__main__':
    if '--report' in sys.argv:
        i = sys.argv.index('--report')
        hours = float(sys.argv[i + 1]) if len(sys.argv) > i + 1 and not sys.argv[i + 1].startswith('-') else 24
        k = int(sys.argv[sys.argv.index('--units') + 1]) if '--units' in sys.argv else 5
        report(hours, k)
    else:
        record()
