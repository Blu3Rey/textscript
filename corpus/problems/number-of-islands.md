---
title: Number of Islands
inputs: grid
split: test
tags: grid, graph, depth-first-search
---
You are given `grid`, a rectangular list of rows, where each cell is `1`
(land) or `0` (water). Land cells that touch along a side (up, down, left
or right, not diagonally) belong to the same island. Return how many
separate islands the grid contains. The grid has at least one row and one
column, and you may change its cells.

Example: for

```
[[1, 1, 0, 0],
 [1, 0, 0, 1],
 [0, 0, 1, 1]]
```

the answer is `2`.
