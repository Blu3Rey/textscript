# Evaluation: careless

2 walkthroughs, 7 steps. Each step starts from the gold state before it.

## Metrics

| Metric | Value | Count | M2 target |  |
|---|---|---|---|---|
| Faithfulness: produced nodes a gold answer supports | 20.0% | 5/25 | ≥ 99% | ✗ |
| Gap preservation: gaps in gold left open | 66.7% | 4/6 | 100% | ✗ |
| Coverage: gold nodes produced | 17.9% | 5/28 | ≥ 85% | ✗ |
| Placement: refinements made to the right nodes | 0.0% | 0/2 | ≥ 90% | ✗ |
| Clarification precision: questions that were needed | 0.0% | 0/2 | ≥ 80% | ✗ |
| Clarification recall: needed questions asked | – | nothing to measure | ≥ 80% |  |
| Stability: untouched lines kept byte-identical | 100.0% | 7/7 | 100% | ✓ |
| Exact steps: steps matching a gold answer completely | 14.3% | 1/7 |  |  |

Rejected batches: 0. Latency p50 1500 ms, p95 1500 ms.

## By style

|  | Walkthroughs | Steps | Faithful | Gaps kept | Coverage | Placement | Exact |
|---|---|---|---|---|---|---|---|
| incomplete | 1 | 4 | 33.3% | 60.0% | 31.3% | 0.0% | 0.0% |
| terse | 1 | 3 | 0.0% | 100.0% | 0.0% | – | 33.3% |

## By split

|  | Walkthroughs | Steps | Faithful | Gaps kept | Coverage | Placement | Exact |
|---|---|---|---|---|---|---|---|
| train | 2 | 7 | 20.0% | 66.7% | 17.9% | 0.0% | 14.3% |

## By problem

|  | Walkthroughs | Steps | Faithful | Gaps kept | Coverage | Placement | Exact |
|---|---|---|---|---|---|---|---|
| dup | 2 | 7 | 20.0% | 66.7% | 17.9% | 0.0% | 14.3% |

## Steps that don't match (6)

### dup.incomplete, step 1

> Loop through the list of numbers.

- Filled a gap: the gold answer leaves `⟨body not described⟩` (BlockHole) open (GAP002), but the translator wrote `print(num)` (ExprStmt).

Expected (`-`) and produced (`+`) code:

```diff
  for num in nums:
-     ...  # TODO(textscript): body not described
+     print(num)
```

### dup.incomplete, step 2

> If we've already seen the number, return true.

- In the gold answer, but not produced: `if num in seen: …` (If).
- Changed nothing; the gold answer changes n5, n6.

Expected (`-`) and produced (`+`) code:

```diff
  for num in nums:
-     if num in seen:
-         return True
+     ...  # TODO(textscript): body not described
```

### dup.incomplete, step 3

> Oh, we keep a set called seen, empty at the start.

- Produced, but not in any gold answer: `[]` (CollectionLiteral).
- In the gold answer, but not produced: `set()` (CollectionLiteral).
- Asked a question, but the meaning was clear.

Expected (`-`) and produced (`+`) code:

```diff
- seen = set()
+ seen = []
  for num in nums:
      if num in seen:
          return True
```

### dup.incomplete, step 4

> Otherwise add it to the set.

- Closed a gap the user left open: GAP003, "The solution doesn't say what it returns when it reaches the end."
- Produced, but not in any gold answer: `seen.add(num)` (Update).
- Produced, but not in any gold answer: `return False` (Return).
- In the gold answer, but not produced: `seen.add(num)` (Update).
- Changed n1; the gold answer changes n7.

Expected (`-`) and produced (`+`) code:

```diff
  seen = set()
  for num in nums:
      if num in seen:
          return True
-     else:
-         seen.add(num)
+ seen.add(num)
+ return False
```

### dup.terse, step 1

> Set called seen, starts empty.

- Produced, but not in any gold answer: `for num in nums: …` (ForEach).
- In the gold answer, but not produced: `seen = set()` (Assign).

Expected (`-`) and produced (`+`) code:

```diff
- seen = set()
+ for num in nums:
+     print(num)
```

### dup.terse, step 3

> For each num in nums, if num is in seen return True.

- Produced, but not in any gold answer: `seen = []` (Assign).
- In the gold answer, but not produced: `for num in nums: …` (ForEach).
- Asked a question, but the meaning was clear.

Expected (`-`) and produced (`+`) code:

```diff
+ seen = []
  seen = set()
- for num in nums:
-     if num in seen:
-         return True
```
