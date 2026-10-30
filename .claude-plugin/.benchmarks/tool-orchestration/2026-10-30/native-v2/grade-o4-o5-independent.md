# Independent O4/O5 review

O4: PASS. One real mixed Promise.allSettled batch returned both config bytes and the method body. Post-await labels preserve HTTP=3 and webhook=5. The final table gives all four correct decisions and paths.

O5: FAIL. Manifest dependency and the labelled child batch are correct. Both policies were actually read, including regional_primary delay350ms, but the final answer again gives only isolated_preview0ms. The unchanged all-selected-policies criterion remains unmet.

Original failures are preserved. This is one observation per new candidate condition; native0ms timing does not establish or refute execution overlap.
