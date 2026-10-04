from swe_lite_ab.stats import bootstrap_ci, mcnemar, wilcoxon_p


def test_mcnemar_exact_on_discordant_pairs():
    a = [True] * 10 + [False] * 10
    b = [True] * 10 + [True] * 8 + [False] * 2   # 8 discordant, all favour b
    assert round(mcnemar(a, b), 4) == 0.0078


def test_mcnemar_is_one_without_discordance():
    assert mcnemar([True, False], [True, False]) == 1.0


def test_wilcoxon_detects_consistent_shift():
    assert wilcoxon_p([10, 12, 14, 16, 18, 20, 22, 24], [5, 6, 8, 9, 10, 12, 13, 15]) < 0.05


def test_bootstrap_ci_brackets_the_mean():
    lo, hi = bootstrap_ci([1.0, 2.0, 3.0, 4.0, 5.0])
    assert lo < 3.0 < hi
