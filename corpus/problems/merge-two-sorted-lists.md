---
title: Merge Two Sorted Lists
inputs: list1, list2
split: train
tags: linked-list, recursion
---
You are given `list1` and `list2`, the first nodes of two singly linked
lists whose values are each in non-decreasing order. Each node has a value
`val` and a pointer `next` to the following node (`None` after the last
one), and `ListNode(x)` creates a new node holding `x`. Either list may be
empty (`None`). Combine the two lists into one list in non-decreasing order
by relinking their nodes, and return the first node of the result.

Example: `1 -> 2 -> 4` and `1 -> 3 -> 4` combine into
`1 -> 1 -> 2 -> 3 -> 4 -> 4`.
