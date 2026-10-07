// A line diff for reports: longest common subsequence, no heuristics.

export interface DiffLine {
  type: 'same' | 'removed' | 'added';
  text: string;
}

export function diffLines(expected: string, actual: string): DiffLine[] {
  const a = expected.replace(/\n$/, '').split('\n');
  const b = actual.replace(/\n$/, '').split('\n');
  if (expected === '') a.length = 0;
  if (actual === '') b.length = 0;
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );
  const at = (i: number, j: number) => lengths[i]?.[j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lengths[i];
    if (row === undefined) continue;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) {
      lines.push({ type: 'same', text: left });
      i++;
      j++;
    } else if (right === undefined || (left !== undefined && at(i + 1, j) >= at(i, j + 1))) {
      lines.push({ type: 'removed', text: left ?? '' });
      i++;
    } else {
      lines.push({ type: 'added', text: right });
      j++;
    }
  }
  return lines;
}
