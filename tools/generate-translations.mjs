/**
 * Builds and refreshes the German translation files for the nodes.
 *
 * n8n resolves a node translation as
 * `<dir of the node file>/translations/<locale>/<full node type>.json`, and it
 * only strips its own `n8n-nodes-base.` prefix — so for a community package the
 * file name is the whole type, package and node: papierkram twice over. It is read
 * only when the instance runs with a locale other than `en`
 * (`N8N_DEFAULT_LOCALE=de`), and every missing key falls back to English, which
 * is what makes a partial translation harmless.
 *
 * The generator never overwrites a translated value. It adds the keys a node has
 * grown, drops the ones it lost, and reports what is still untranslated — the
 * point being that a new parameter cannot slip into a German instance in English
 * without somebody being told.
 *
 * What it cannot see: an English text that changed while its key stayed. The
 * German then quietly describes the previous behaviour, which is worse than an
 * untranslated string because nothing looks wrong. Reword an existing
 * description and the translation has to be reworded by hand.
 *
 * What it does now report is the other trap, which is worse because it cannot
 * be fixed by translating more carefully. n8n builds an option's key from the
 * *parameter name* and the *option value* only - `operation` + `get` - and every
 * resource declares its own `operation` property. So one key carries the text of
 * every resource that has that operation, and whatever German is written there
 * is shown for all of them. English does not have this problem: with no
 * translation n8n uses each property's own text, so the collapse only appears
 * once the locale is switched.
 *
 * Such keys must therefore be worded so that they are true for every resource
 * that shares them, or left untranslated. They are listed at the end of a run.
 *
 *   npm run translations
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LOCALE = 'de';

/** Everything a user reads, flattened into the dotted keys n8n expects. */
function keysOf(properties, prefix = 'nodeView') {
	const keys = [];
	for (const property of properties ?? []) {
		const base = `${prefix}.${property.name}`;
		for (const field of ['displayName', 'description', 'placeholder']) {
			if (property[field]) keys.push([`${base}.${field}`, property[field]]);
		}
		if (property.typeOptions?.multipleValueButtonText) {
			keys.push([`${base}.multipleValueButtonText`, property.typeOptions.multipleValueButtonText]);
		}
		for (const option of property.options ?? []) {
			if (option.value !== undefined) {
				// An entry in a dropdown.
				keys.push([`${base}.options.${option.value}.name`, option.name]);
				if (option.description) {
					keys.push([`${base}.options.${option.value}.description`, option.description]);
				}
			} else {
				// A collection or fixedCollection: a named group of further fields.
				keys.push([`${base}.options.${option.name}.displayName`, option.displayName ?? option.name]);
				keys.push(...keysOf(option.values ?? option.options ?? [], `${base}.options.${option.name}`));
			}
		}
	}
	return keys;
}

const packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
const nodesDir = join(root, 'dist', 'nodes');

if (!existsSync(nodesDir)) {
	console.error('Build first: the translations are derived from the compiled node descriptions.');
	process.exit(1);
}

let missingTotal = 0;
let sharedTotal = 0;

for (const dir of readdirSync(nodesDir)) {
	const entry = readdirSync(join(nodesDir, dir)).find((file) => file.endsWith('.node.js'));
	if (entry === undefined) continue;

	const module = await import(`file:///${join(nodesDir, dir, entry).replace(/\\/g, '/')}`);
	const NodeClass = Object.values(module).find((value) => typeof value === 'function');
	const description = new NodeClass().description;

	const emitted = keysOf(description.properties);
	const wanted = new Map(emitted);

	// One key, several English texts: the resources share it and only one German
	// can be stored. Reported, not repaired - see the header.
	const texts = new Map();
	for (const [key, english] of emitted) {
		if (!texts.has(key)) texts.set(key, new Set());
		texts.get(key).add(english);
	}
	const shared = [...texts].filter(([, values]) => values.size > 1);

	const target = join(root, 'nodes', dir, 'translations', LOCALE, `${packageName}.${description.name}.json`);

	const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
	const merged = {
		header: {
			displayName: existing.header?.displayName ?? description.displayName,
			description: existing.header?.description ?? description.description,
		},
	};

	const missing = [];
	for (const [key, english] of wanted) {
		if (existing[key] !== undefined) {
			merged[key] = existing[key];
			continue;
		}
		merged[key] = english;
		missing.push(key);
	}

	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

	const dropped = Object.keys(existing).filter((key) => key !== 'header' && !wanted.has(key));
	missingTotal += missing.length;
	sharedTotal += shared.length;
	console.log(
		`${description.name}: ${wanted.size} keys, ${missing.length} still English, ${dropped.length} dropped, ${shared.length} shared -> ${target.slice(root.length)}`,
	);
	for (const [key, values] of shared) {
		console.log(`   shared: ${key} carries ${values.size} English texts`);
		for (const value of values) console.log(`      ${value}`);
	}
}

if (missingTotal > 0) {
	console.log(`\n${missingTotal} keys carry their English text. Translate them in place; the generator keeps whatever it finds.`);
}

if (sharedTotal > 0) {
	console.log(
		`\n${sharedTotal} key(s) are shared by several resources. The German stored there is shown for all of them, ` +
			'so it has to be true for all of them: name every case or word it neutrally.',
	);
}
