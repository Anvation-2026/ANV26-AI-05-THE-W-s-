"""JavaScript number behaviour that the simulator's text and random numbers depend on.

The decision log contains sentences with numbers in them, and the arrivals come from a seeded generator. For the
Python simulator to match the browser exactly, these must behave like their JavaScript counterparts.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

M32 = 0xFFFFFFFF


def js_round(x: float) -> int:
    """Math.round: halves go up (toward positive infinity), unlike Python's round()."""
    return math.floor(x + 0.5)


def to_fixed(x: float, digits: int) -> str:
    """Number.prototype.toFixed: rounds the exact binary value half up, where Python's format rounds ties to even."""
    if not math.isfinite(x):
        return "NaN" if math.isnan(x) else ("Infinity" if x > 0 else "-Infinity")
    q = Decimal(1).scaleb(-digits)
    s = str(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))
    if s.startswith("-") and float(s) == 0:  # (-0.0001).toFixed(1) is "-0.0" in JavaScript; keep that quirk
        return s
    return s


def num(x: float) -> str:
    """String(number): integers without a decimal point, other values with the shortest round-trip digits."""
    if isinstance(x, bool):
        return str(x).lower()
    if isinstance(x, int):
        return str(x)
    if not math.isfinite(x):
        return "NaN" if math.isnan(x) else ("Infinity" if x > 0 else "-Infinity")
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    return repr(x)


def imul(a: int, b: int) -> int:
    """Math.imul on unsigned 32-bit patterns."""
    return (a * b) & M32


def mulberry32(seed: int):  # type: ignore[no-untyped-def]
    """Same generator as src/engine/rng.ts. Returns a function giving the next number in [0, 1)."""
    a = int(seed) & M32

    def rng() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = a
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return rng


def poisson(rng, lam: float) -> int:  # type: ignore[no-untyped-def]
    """Knuth sampler, capped at 20 like the browser's."""
    if lam <= 0:
        return 0
    limit = math.exp(-lam)
    k = 0
    p = 1.0
    while True:
        k += 1
        p *= rng()
        if not (p > limit and k < 20):
            break
    return k - 1


def pick_class(rng, mix: Mapping[Any, float], keys: tuple[str, ...]) -> str:  # type: ignore[no-untyped-def]
    r = rng()
    for k in keys:
        r -= mix[k]
        if r <= 0:
            return k
    return keys[-1]


def hash01(n: int) -> float:
    x = (int(n) + 0x9E3779B9) & M32
    x = imul(x ^ (x >> 16), 0x85EBCA6B)
    x = imul(x ^ (x >> 13), 0xC2B2AE35)
    x ^= x >> 16
    return (x & M32) / 4294967296
