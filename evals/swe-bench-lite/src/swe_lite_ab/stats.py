import random

from scipy.stats import binomtest, wilcoxon


def mcnemar(a: list[bool], b: list[bool]) -> float:
    only_a = sum(x and not y for x, y in zip(a, b))
    only_b = sum(y and not x for x, y in zip(a, b))
    if only_a + only_b == 0:
        return 1.0
    return binomtest(only_a, only_a + only_b, 0.5).pvalue


def wilcoxon_p(a: list[float], b: list[float]) -> float:
    if all(x == y for x, y in zip(a, b)):
        return 1.0
    return float(wilcoxon(a, b).pvalue)


def bootstrap_ci(diffs: list[float], seed: int = 0, n: int = 10000) -> tuple[float, float]:
    rng = random.Random(seed)
    means = sorted(sum(rng.choices(diffs, k=len(diffs))) / len(diffs) for _ in range(n))
    return means[int(0.025 * n)], means[int(0.975 * n) - 1]
