"""Plackett-Luce / Henery calibration head (EVAL-ONLY, Phase 1).

Converts per-runner model scores into calibrated additive top-N probabilities
(pWin / pTop3 / pTop4) plus an analytic box-coverage forecast
E[trio_nN] = P(actual top-3 set within our top-N) and
E[first4_nN] = P(actual top-4 set within our top-N).

Worth v_i = exp(s_i / tau). Harville == Henery with all gamma = 1.
Because v is a strictly-monotone transform of a single score and every top-k
marginal is monotone in v, the predicted top-N SET equals the score top-N set
=> realized box coverage / box ROI are UNCHANGED by this head. It only produces
calibrated probabilities + an analytic coverage forecast; it is NOT a
coverage/EV lift (architect-confirmed monotonicity 2026-06-29).
"""
from __future__ import annotations
import math
import numpy as np

GAMMA_BOUNDS = (0.05, 5.0)
TAU_BOUNDS = (0.01, 100.0)
_EPS = 1e-12


def _minimize_1d(f, lo: float, hi: float, grid: int = 33,
                 iters: int = 60, tol: float = 1e-6) -> float:
    """Minimize a smooth, ~unimodal 1-D function on [lo, hi]: a coarse grid
    locates the bracket, then golden-section refines it. numpy-only (no scipy
    dependency, since CI installs only lightgbm/pandas/numpy)."""
    xs = np.linspace(lo, hi, grid)
    fs = [f(float(x)) for x in xs]
    j = int(np.argmin(fs))
    a = float(xs[max(0, j - 1)])
    b = float(xs[min(grid - 1, j + 1)])
    invphi = (math.sqrt(5.0) - 1.0) / 2.0
    c = b - invphi * (b - a)
    d = a + invphi * (b - a)
    fc, fd = f(c), f(d)
    for _ in range(iters):
        if (b - a) < tol:
            break
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - invphi * (b - a)
            fc = f(c)
        else:
            a, c, fc = c, d, fd
            d = a + invphi * (b - a)
            fd = f(d)
    return 0.5 * (a + b)


def worths(scores, tau: float = 1.0) -> np.ndarray:
    """Henery/PL worths v_i = exp(s_i / tau), shifted by max for stability."""
    s = np.asarray(scores, dtype=float) / max(float(tau), 1e-6)
    s = s - s.max()
    return np.exp(s)


def pwin(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=float)
    tot = v.sum()
    return v / tot if tot > 0 else np.full(len(v), 1.0 / max(len(v), 1))


def _gamma_at(gamma, r: int) -> float:
    return float(gamma[r]) if r < len(gamma) else float(gamma[-1])


def place_marginals(v, gamma, K: int) -> np.ndarray:
    """N x K array p_pos[i, r] = P(horse i finishes in position r) (r 0-indexed)
    under the Henery sequential model with position exponents `gamma`
    (gamma[0] must be 1.0). Exact via depth-K DFS over ordered prefixes;
    each stage's denominator is the sum of v**gamma over the REMAINING field.
    Positions deeper than r integrate out, so p_pos[:, r] depends only on
    gamma[0..r]."""
    v = np.asarray(v, dtype=float)
    N = len(v)
    K = min(K, N)
    p_pos = np.zeros((N, K))
    if N == 0:
        return p_pos
    vg = [v ** _gamma_at(gamma, r) for r in range(K)]

    def rec(depth: int, prob: float, used: np.ndarray) -> None:
        w = vg[depth] * (~used)
        denom = w.sum()
        if denom <= 0:
            return
        contrib = prob * w / denom          # vector over N, 0 where used
        p_pos[:, depth] += contrib
        if depth + 1 < K:
            for i in np.nonzero(~used)[0]:
                used[i] = True
                rec(depth + 1, contrib[i], used)
                used[i] = False

    rec(0, 1.0, np.zeros(N, dtype=bool))
    return p_pos


def top_k_probs(v, gamma, K: int) -> np.ndarray:
    """N x K cumulative: column k-1 = pTopK_i = P(horse i finishes within top k)."""
    return np.cumsum(place_marginals(v, gamma, K), axis=1)


def toporder_nll(v, gamma, order) -> float:
    """Negative log-likelihood of the observed finishing prefix `order`
    (local indices, best first) under the Henery model. Lower = better fit.
    Harville = pass gamma all 1.0."""
    v = np.asarray(v, dtype=float)
    used = np.zeros(len(v), dtype=bool)
    nll = 0.0
    for r, idx in enumerate(order):
        g = _gamma_at(gamma, r)
        w = (v ** g) * (~used)
        denom = w.sum()
        if denom <= 0:
            return float("nan")
        nll += -math.log(max(float((v[idx] ** g) / denom), _EPS))
        used[idx] = True
    return nll


def coverage_prob(v, gamma, S, m: int) -> float:
    """P(the top-m finishers ALL fall within index set S). m=3 -> trio/三重彩
    box coverage; m=4 -> first4/四重彩. Denominators are over the full field."""
    v = np.asarray(v, dtype=float)
    N = len(v)
    m = min(m, N)
    if m == 0:
        return 1.0
    vg = [v ** _gamma_at(gamma, r) for r in range(m)]
    Sl = [int(i) for i in S]

    def rec(depth: int, prob: float, used: np.ndarray) -> float:
        if depth == m:
            return prob
        w = vg[depth] * (~used)
        denom = w.sum()
        if denom <= 0:
            return 0.0
        tot = 0.0
        for i in Sl:
            if used[i]:
                continue
            used[i] = True
            tot += rec(depth + 1, prob * w[i] / denom, used)
            used[i] = False
        return tot

    return rec(0, 1.0, np.zeros(N, dtype=bool))


# ───────── leak-safe calibrator fitting (trailing OOF window) ─────────
# A "race" for fitting is (scores: 1-D array, order: list[int] of local indices
# in finishing order, best first). winner = order[0].

def fit_tau(races) -> float:
    """Winner-only per-race logloss MLE (mirrors predict_upcoming.fit_temperature),
    optimised in log-space. races scored OUT-OF-FOLD so calibration is honest."""
    races = [(np.asarray(sc, float), order) for sc, order in races
             if order is not None and len(order) >= 1]
    if not races:
        return 1.0

    def loss(log_tau: float) -> float:
        tau = math.exp(log_tau)
        tot, n = 0.0, 0
        for sc, order in races:
            p = pwin(worths(sc, tau))
            tot += -math.log(max(float(p[order[0]]), _EPS))
            n += 1
        return tot / n if n else float("inf")

    best = _minimize_1d(loss, math.log(TAU_BOUNDS[0]), math.log(TAU_BOUNDS[1]))
    return float(math.exp(best))


def fit_gamma_pos(races, tau: float, pos: int) -> float:
    """Henery exponent for finishing position `pos` (0-indexed): pos=1 -> gamma2
    (predict actual 2nd given 1st removed), pos=2 -> gamma3, etc. Conditional MLE
    over log-gamma. Uses worths at the already-fitted tau (sequential fit)."""
    races = [(np.asarray(sc, float), order) for sc, order in races
             if order is not None and len(order) > pos]
    if not races:
        return 1.0

    def loss(log_g: float) -> float:
        g = math.exp(log_g)
        tot, n = 0.0, 0
        for sc, order in races:
            v = worths(sc, tau)
            mask = np.ones(len(v), dtype=bool)
            for r in order[:pos]:
                mask[r] = False
            target = order[pos]
            if not mask[target]:
                continue
            w = v[mask] ** g
            denom = w.sum()
            if denom <= 0:
                continue
            num = v[target] ** g
            tot += -math.log(max(float(num / denom), _EPS))
            n += 1
        return tot / n if n else float("inf")

    best = _minimize_1d(loss, math.log(GAMMA_BOUNDS[0]), math.log(GAMMA_BOUNDS[1]))
    return float(math.exp(best))


def fit_calibrator(races, max_pos: int = 3):
    """Fit tau then gamma2..gamma_{max_pos} sequentially on an OOF window.
    Returns (tau, gamma_list) where gamma_list[0]=1.0."""
    tau = fit_tau(races)
    gamma = [1.0]
    for pos in range(1, max_pos):
        gamma.append(fit_gamma_pos(races, tau, pos))
    return tau, gamma


# ───────── calibration metrics ─────────
def brier(p, y) -> float:
    p = np.asarray(p, float); y = np.asarray(y, float)
    return float(np.mean((p - y) ** 2)) if len(p) else float("nan")


def binary_logloss(p, y) -> float:
    p = np.clip(np.asarray(p, float), _EPS, 1 - _EPS)
    y = np.asarray(y, float)
    return float(np.mean(-(y * np.log(p) + (1 - y) * np.log(1 - p)))) if len(p) else float("nan")


def ece(p, y, bins: int = 10) -> float:
    """Expected calibration error (equal-width bins)."""
    p = np.asarray(p, float); y = np.asarray(y, float)
    n = len(p)
    if n == 0:
        return float("nan")
    edges = np.linspace(0.0, 1.0, bins + 1)
    e = 0.0
    for b in range(bins):
        lo, hi = edges[b], edges[b + 1]
        m = (p >= lo) & (p <= hi) if b == bins - 1 else (p >= lo) & (p < hi)
        c = int(m.sum())
        if c:
            e += abs(float(p[m].mean()) - float(y[m].mean())) * c / n
    return float(e)


def reliability_deciles(p, y, bins: int = 10):
    """List of {bin, n, mean_pred, mean_obs} for a predicted-vs-observed curve."""
    p = np.asarray(p, float); y = np.asarray(y, float)
    out = []
    if len(p) == 0:
        return out
    edges = np.linspace(0.0, 1.0, bins + 1)
    for b in range(bins):
        lo, hi = edges[b], edges[b + 1]
        m = (p >= lo) & (p <= hi) if b == bins - 1 else (p >= lo) & (p < hi)
        c = int(m.sum())
        out.append({"bin": b, "lo": round(float(lo), 2), "hi": round(float(hi), 2),
                    "n": c,
                    "mean_pred": (round(float(p[m].mean()), 4) if c else None),
                    "mean_obs": (round(float(y[m].mean()), 4) if c else None)})
    return out
