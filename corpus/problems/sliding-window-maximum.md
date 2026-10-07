---
title: Sliding Window Maximum
inputs: nums, k
split: train
tags: array, deque, sliding-window
---
Given a list of integers `nums` and a window size `k` (between 1 and the
length of `nums`), look at every run of `k` consecutive elements, from the
leftmost to the rightmost. Return a list holding the largest value of each
run, in that order.

Example: for `nums = [4, 2, 12, 3, 8, 1]` and `k = 3` the answer is
`[12, 12, 12, 8]`.
