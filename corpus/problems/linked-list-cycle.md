---
title: Linked List Cycle
inputs: head
split: test
tags: linked-list, two-pointers
---
You are given `head`, the first node of a singly linked list (possibly
`None`). Each node has a value `val` and a pointer `next`. Normally the last
node's `next` is `None`, but a `next` pointer might instead point back to a
node earlier in the list, so following `next` would go around forever.
Return `True` if following `next` from `head` ever reaches a node it has
already passed, and `False` if it reaches the end.

Example: in `1 -> 2 -> 3 -> 4` where node `4`'s `next` is node `2`, the
answer is `True`; for `1 -> 2 -> None` it is `False`.
