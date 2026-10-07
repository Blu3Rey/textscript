---
title: Merge Intervals
inputs: intervals
split: train
tags: array, sorting
---
`intervals` is a list of intervals, each a two-element list `[start, end]`
with `start <= end`. Combine every group of intervals that overlap into one
interval covering them all, and return the resulting intervals in any
order.

Example: for `intervals = [[1, 3], [2, 6], [8, 10], [15, 18]]` the answer is
`[[1, 6], [8, 10], [15, 18]]`.
