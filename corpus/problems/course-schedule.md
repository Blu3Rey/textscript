---
title: Course Schedule
inputs: num_courses, prerequisites
split: train
tags: graph, topological-sort
---
There are `num_courses` courses, numbered `0` to `num_courses - 1`. Each
entry of `prerequisites` is a pair `[a, b]` meaning course `b` has to be
finished before course `a` can be started. Return `True` if there is an
order in which every course can be finished, and `False` otherwise.

Example: with `num_courses = 2`, `prerequisites = [[1, 0]]` gives `True`
(take `0`, then `1`), while `[[1, 0], [0, 1]]` gives `False`.
