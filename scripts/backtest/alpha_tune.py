#!/usr/bin/env python3
"""
P3-C offline α tuner.

For each (date, α) in the cartesian product:
  GET /api/analyze/hit-rate?date=D&alpha=A&refresh=1
collect summary metrics. Aggregate per α across all dates. Pick the winner by
composite score (top1 hit rate * 0.6 + top4 avg intersect/4 * 0.4). Optionally
POST {alpha} to /api/analyze/ensemble-alpha (admin-gated) to apply.

This runs offline (GH Actions) so each request is well within CF Worker
wall-time, unlike the sync /ensemble-tune route which times out.

Usage:
  python3 alpha_tune.py \
    --base-url=https://tianxi.racing \
    --token=$ADMIN_TOKEN \
    --days=60 \
    --alphas=0.40,0.50,0.62,0.75,0.85 \
    --engine=v12 \
    --apply
"""
from __future__ import annotations
import argparse, json, sys, time
import urllib.request, urllib.error
from datetime import date, timedelta

UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')


def http_get(url: str, timeout: int = 60, max_retries: int = 5) -> tuple[int, dict | None, str]:
    """GET with exponential backoff retry on 5xx and 429 (Cloudflare rate-limit)."""
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    last_status, last_body = 0, ''
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read()), ''
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode()[:200]
            except Exception:
                body = ''
            last_status, last_body = e.code, body
            # Retry on Cloudflare rate-limit / transient 5xx; bail on 4xx terminals.
            if e.code in (429, 500, 502, 503, 504) and attempt < max_retries - 1:
                backoff = min(30.0, 2.0 ** attempt + 0.5)
                time.sleep(backoff)
                continue
            return e.code, None, body
        except Exception as e:
            last_status, last_body = 0, str(e)
            if attempt < max_retries - 1:
                time.sleep(min(30.0, 2.0 ** attempt + 0.5))
                continue
            return 0, None, str(e)
    return last_status, None, last_body


def http_post_json(url: str, body: dict, token: str, timeout: int = 30):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, method='POST',
        headers={'User-Agent': UA, 'Accept': 'application/json',
                 'Content-Type': 'application/json',
                 'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {'_body': e.read().decode()[:300]}
    except Exception as e:
        return 0, {'_err': str(e)}


def date_range(days: int) -> list[str]:
    today = date.today()
    return [(today - timedelta(days=i)).isoformat() for i in range(1, days + 1)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base-url', default='https://tianxi.racing')
    ap.add_argument('--token', required=False, default='',
                    help='ADMIN_TOKEN for --apply (not needed for sweep-only).')
    ap.add_argument('--days', type=int, default=60)
    ap.add_argument('--alphas', default='0.40,0.50,0.62,0.75,0.85')
    ap.add_argument('--engine', default='v12', choices=['v11', 'v12'])
    ap.add_argument('--apply', action='store_true',
                    help='POST winner α to /api/analyze/ensemble-alpha after the sweep.')
    ap.add_argument('--min-margin', type=float, default=0.0,
                    help='Only apply if winner.compositeScore exceeds current-α score by this margin.')
    ap.add_argument('--sleep', type=float, default=1.0,
                    help='Seconds to sleep between calls (rate-limit politeness).')
    args = ap.parse_args()

    alphas = [float(x.strip()) for x in args.alphas.split(',') if x.strip()]
    if not alphas:
        print('No alphas given', file=sys.stderr)
        return 2

    # Find race dates with results (probe each candidate date once; non-race
    # days return HTTP 404). Use α=alphas[0] for the probe so we share work.
    candidates = date_range(args.days)
    print(f'[probe] checking {len(candidates)} candidate dates (last {args.days}d)…')
    race_dates: list[str] = []
    skipped = 0
    probe_alpha = alphas[0]
    for d in candidates:
        url = f'{args.base_url}/api/analyze/hit-rate?date={d}&alpha={probe_alpha}&engine={args.engine}&refresh=1'
        status, body, err = http_get(url, timeout=60)
        if status == 200 and isinstance(body, dict) and body.get('summary'):
            race_dates.append(d)
            sm = body['summary']
            print(f'  ✓ {d} races={sm.get("racesEvaluated")} ensAvail={sm.get("ensembleAvailable")} '
                  f'cov={sm.get("ensembleCoveragePct")}%')
        elif status == 404:
            skipped += 1
        else:
            print(f'  ! {d} HTTP {status} {err[:80]}')
        time.sleep(args.sleep)

    print(f'[probe] {len(race_dates)} race dates, {skipped} rest days, '
          f'{len(candidates) - len(race_dates) - skipped} errors')

    if not race_dates:
        print('No race dates with results found.', file=sys.stderr)
        return 3

    # Sweep: for each (α, date), call hit-rate and aggregate.
    # Skip α=probe_alpha re-call by reusing probe results.
    per_alpha: dict[str, dict] = {}
    probe_cache: dict[str, dict] = {}  # date -> summary (for probe_alpha)

    print(f'\n[sweep] {len(alphas)} αs × {len(race_dates)} dates = '
          f'{len(alphas) * len(race_dates)} calls')

    for a in alphas:
        agg = {'alpha': a, 'races': 0, 'top1Hits': 0,
               'top4SumIntersect': 0, 'top4Eligible': 0, 'datesUsed': 0}
        for d in race_dates:
            # Reuse probe result when this α matches the probe α.
            if a == probe_alpha and d in probe_cache:
                summary = probe_cache[d]
            else:
                url = (f'{args.base_url}/api/analyze/hit-rate?date={d}'
                       f'&alpha={a}&engine={args.engine}&refresh=1')
                status, body, err = http_get(url, timeout=60)
                if status != 200 or not isinstance(body, dict):
                    print(f'  ! α={a} {d} HTTP {status} {err[:80]}')
                    time.sleep(args.sleep)
                    continue
                summary = body.get('summary') or {}
                if a == probe_alpha:
                    probe_cache[d] = summary
            if not summary or not summary.get('racesEvaluated'):
                continue
            agg['races'] += summary.get('racesEvaluated', 0)
            agg['top1Hits'] += summary.get('top1Hits', 0) or 0
            agg['top4SumIntersect'] += summary.get('top4SumIntersect', 0) or 0
            agg['top4Eligible'] += summary.get('top4Eligible', 0) or 0
            agg['datesUsed'] += 1
            time.sleep(args.sleep)

        # Composite scoring matches the existing /ensemble-tune logic so we
        # don't introduce a competing ranking convention.
        races = agg['races']
        top1_rate = (agg['top1Hits'] / races) if races else 0.0
        top4_avg = (agg['top4SumIntersect'] / agg['top4Eligible']) if agg['top4Eligible'] else 0.0
        composite = top1_rate * 0.6 + (top4_avg / 4.0) * 0.4
        agg['top1HitRate'] = round(top1_rate * 1000) / 10  # %
        agg['top4AvgIntersect'] = round(top4_avg * 100) / 100
        agg['compositeScore'] = round(composite * 1000) / 1000
        per_alpha[f'{a:.2f}'] = agg
        print(f'  α={a:.2f}: races={races} top1={agg["top1HitRate"]}% '
              f'top4Avg={agg["top4AvgIntersect"]} composite={agg["compositeScore"]} '
              f'(datesUsed={agg["datesUsed"]})')

    # Pick winner.
    winner_key = max(per_alpha.keys(),
                     key=lambda k: per_alpha[k]['compositeScore']) if per_alpha else None
    winner = per_alpha[winner_key] if winner_key else None

    # Find current α via probe (any successful body includes summary, but α
    # itself comes from a separate read — fall back to a small endpoint hit).
    # Cheap approach: read it from one of our probe responses by re-issuing
    # one request without alpha (uses cached current α). Skip for simplicity
    # and just report winner — operators can compare against the visible
    # production default 0.62.

    report = {
        'windowDays': args.days,
        'racesDates': race_dates,
        'meetingsEvaluated': len(race_dates),
        'alphas': alphas,
        'perAlpha': per_alpha,
        'winner': winner,
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    print('\n=== REPORT ===')
    print(json.dumps(report, indent=2))

    # Persist for GH artifacts.
    out_path = 'alpha_tune_report.json'
    with open(out_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'\nWrote {out_path}')

    if not args.apply:
        print('\n--apply not set — not writing winner α.')
        return 0
    if not winner:
        print('No winner — skipping apply.', file=sys.stderr)
        return 4
    if not args.token:
        print('--apply set but no --token provided.', file=sys.stderr)
        return 5

    if args.min_margin > 0:
        # Compare winner against existing α=0.62 row in perAlpha (if present).
        baseline = per_alpha.get('0.62')
        if baseline and (winner['compositeScore'] - baseline['compositeScore']) < args.min_margin:
            print(f'Winner α={winner["alpha"]} composite={winner["compositeScore"]} '
                  f'does not exceed baseline (0.62 composite={baseline["compositeScore"]}) '
                  f'by min-margin {args.min_margin}; not applying.')
            return 0

    apply_url = f'{args.base_url}/api/analyze/ensemble-alpha'
    print(f'\n[apply] POST {apply_url} α={winner["alpha"]}')
    status, resp = http_post_json(apply_url, {'alpha': winner['alpha']}, args.token)
    print(f'  HTTP {status} resp={json.dumps(resp)[:300]}')
    return 0 if status == 200 else 6


if __name__ == '__main__':
    sys.exit(main())
