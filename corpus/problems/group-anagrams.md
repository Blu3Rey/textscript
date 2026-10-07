---
title: Group Anagrams
inputs: strs
split: test
tags: string, hash-map, sorting
---
Given a list of strings `strs`, put the strings into groups so that two
strings share a group exactly when one is a rearrangement of the other's
characters. Return the groups as a list of lists; neither the groups nor
the strings inside a group need to be in any particular order.

Example: for `["stop", "pots", "cat", "tops", "act", "dog"]` one valid
answer is `[["stop", "pots", "tops"], ["cat", "act"], ["dog"]]`.
