/**
 * Runs a Darkroom bundle through DarkRelay's own code: the CLI's planBundle
 * (file roles, episode.json schema) and validateChapters.
 * Usage: tsx darkrelay_check.mts <darkrelay checkout> <bundle dir>
 * Exits non-zero with the reasons if DarkRelay would refuse or ignore anything.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [darkrelay, bundle] = process.argv.slice(2) as [string, string];
const cli = await import(pathToFileURL(join(darkrelay, 'packages/cli/src/commands/publish.ts')).href);
const core = await import(pathToFileURL(join(darkrelay, 'packages/core/src/index.ts')).href);

const episode = JSON.parse(await readFile(join(bundle, 'episode.json'), 'utf8'));
const plan = await cli.planBundle(bundle, { show: episode.show }, async () => {
  throw new Error('durationSeconds should come from episode.json');
});

const problems: string[] = [];
const names = (await readdir(bundle)).filter((n) => n !== 'episode.json');
const uploaded = plan.files.map((f: { name: string }) => f.name);
for (const n of names) if (!uploaded.includes(n)) problems.push(`DarkRelay would not upload ${n}`);
for (const key of Object.keys(episode)) {
  if (JSON.stringify(plan.input[key]) !== JSON.stringify(episode[key])) problems.push(`episode.json ${key} changed`);
}
if (names.includes('chapters.json')) {
  problems.push(...core.validateChapters(JSON.parse(await readFile(join(bundle, 'chapters.json'), 'utf8'))));
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`ok: ${uploaded.join(', ')}`);
