// Line-based diff (longest common subsequence) for showing changes in
// text files. Inputs are bounded so the quadratic table stays small.

export type DiffOp = { op: ' ' | '+' | '-'; text: string };

const MAX_CELLS = 4_000_000;

export function diffLines(a: string, b: string): DiffOp[] | null {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length && x[x.length - 1] === '') x.pop();
  if (y.length && y[y.length - 1] === '') y.pop();

  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const xs = x.slice(start, endX);
  const ys = y.slice(start, endY);
  const n = xs.length;
  const m = ys.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // lcs[i][j] = LCS length of xs[i..] and ys[j..]
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = xs[i] === ys[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const out: DiffOp[] = x.slice(0, start).map((text) => ({ op: ' ', text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (xs[i] === ys[j]) {
      out.push({ op: ' ', text: xs[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      out.push({ op: '-', text: xs[i++] });
    } else {
      out.push({ op: '+', text: ys[j++] });
    }
  }
  while (i < n) out.push({ op: '-', text: xs[i++] });
  while (j < m) out.push({ op: '+', text: ys[j++] });
  for (const text of x.slice(endX)) out.push({ op: ' ', text });
  return out;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffOp[];
}

// Groups a diff into hunks with the given number of context lines.
export function hunks(ops: DiffOp[], context = 3): Hunk[] {
  // Line numbers before each op.
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldNo.push(o);
    newNo.push(n);
    if (op.op !== '+') o++;
    if (op.op !== '-') n++;
  }
  // Merge [change - context, change + context] windows.
  const ranges: Array<[number, number]> = [];
  ops.forEach((op, k) => {
    if (op.op === ' ') return;
    const from = Math.max(0, k - context);
    const to = Math.min(ops.length - 1, k + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  });
  return ranges.map(([from, to]) => ({
    oldStart: oldNo[from],
    newStart: newNo[from],
    lines: ops.slice(from, to + 1),
  }));
}
