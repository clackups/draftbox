// Fails if any tracked source file contains non-ASCII characters.
// Translations in locales/ are data, not code, and are exempt.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXEMPT = [/^locales\//];

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !EXEMPT.some((re) => re.test(f)));

let bad = 0;
for (const file of files) {
  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch {
    continue;
  }
  const lines = data.toString('latin1').split('\n');
  lines.forEach((line, i) => {
    const col = line.search(/[^\x00-\x7f]/);
    if (col >= 0) {
      console.error(`${file}:${i + 1}:${col + 1}: non-ASCII character`);
      bad++;
    }
  });
}
if (bad > 0) {
  console.error(`${bad} line(s) with non-ASCII characters`);
  process.exit(1);
}
console.log(`ASCII check passed (${files.length} files)`);
