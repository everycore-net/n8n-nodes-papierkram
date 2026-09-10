/**
 * Copies the node translation files into dist.
 *
 * `n8n-node build` copies only `**\/*.{png,svg}` and `__schema__` JSON, so a
 * translation file lives in the source tree and never ships. Nothing fails: the
 * package builds, publishes and installs, and a German instance simply shows
 * English — which is indistinguishable from having no translation at all and is
 * therefore the kind of bug nobody reports.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const nodesDir = join(root, 'nodes');

let copied = 0;
for (const dir of readdirSync(nodesDir)) {
	const from = join(nodesDir, dir, 'translations');
	if (!existsSync(from)) continue;
	cpSync(from, join(root, 'dist', 'nodes', dir, 'translations'), { recursive: true });
	copied += 1;
}

console.log(`translations copied for ${copied} node(s)`);
