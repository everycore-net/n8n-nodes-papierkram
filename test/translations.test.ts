import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { INodeProperties, INodeTypeDescription } from 'n8n-workflow';

import { Papierkram } from '../nodes/Papierkram/Papierkram.node';
import { PapierkramTrigger } from '../nodes/PapierkramTrigger/PapierkramTrigger.node';

/**
 * A translation cannot fail loudly. A missing key falls back to English, a stale
 * key is ignored, and both look like a node that simply was not translated yet -
 * on a German instance, which is the only place either is visible. So the drift
 * is checked here instead, where it costs a red test rather than a customer
 * reading half an interface in the wrong language.
 *
 * What this cannot check is whether the German is *right*. It checks that every
 * key a user can see has one, and that none is left over.
 */

const LOCALE = 'de';
const PACKAGE = 'n8n-nodes-papierkram';

/** The dotted keys n8n builds for a node's visible text. */
function keysOf(properties: INodeProperties[] | undefined, prefix = 'nodeView'): string[] {
	const keys: string[] = [];
	for (const property of properties ?? []) {
		const base = `${prefix}.${property.name}`;
		for (const field of ['displayName', 'description', 'placeholder'] as const) {
			if (property[field]) keys.push(`${base}.${field}`);
		}
		if (property.typeOptions?.multipleValueButtonText) {
			keys.push(`${base}.multipleValueButtonText`);
		}
		for (const option of (property.options ?? []) as Array<Record<string, unknown>>) {
			if (option.value !== undefined) {
				keys.push(`${base}.options.${String(option.value)}.name`);
				if (option.description) keys.push(`${base}.options.${String(option.value)}.description`);
			} else {
				keys.push(`${base}.options.${String(option.name)}.displayName`);
				keys.push(
					...keysOf(
						(option.values ?? option.options) as INodeProperties[] | undefined,
						`${base}.options.${String(option.name)}`,
					),
				);
			}
		}
	}
	return keys;
}

const nodes: Array<[string, INodeTypeDescription]> = [
	['Papierkram', new Papierkram().description],
	['PapierkramTrigger', new PapierkramTrigger().description],
];

describe.each(nodes)('%s German translation', (dir, description) => {
	const file = join(
		__dirname,
		'..',
		'nodes',
		dir,
		'translations',
		LOCALE,
		`${PACKAGE}.${description.name}.json`,
	);

	it('exists under the name n8n looks for', () => {
		// n8n strips only its own `n8n-nodes-base.` prefix, so a community node's
		// file is named after the whole type: package and node.
		expect(existsSync(file), `expected ${file}`).toBe(true);
	});

	it('translates the node itself', () => {
		const translation = JSON.parse(readFileSync(file, 'utf8'));
		expect(translation.header?.displayName).toBeTruthy();
		expect(translation.header?.description).toBeTruthy();
	});

	it('covers every key the node shows and no others', () => {
		const translation = JSON.parse(readFileSync(file, 'utf8'));
		const wanted = new Set(keysOf(description.properties));
		const have = new Set(Object.keys(translation).filter((key) => key !== 'header'));

		const missing = [...wanted].filter((key) => !have.has(key));
		const stale = [...have].filter((key) => !wanted.has(key));

		expect(missing, 'keys without a translation').toEqual([]);
		expect(stale, 'translations for keys the node no longer has').toEqual([]);
	});

	it('has no empty translation', () => {
		const translation = JSON.parse(readFileSync(file, 'utf8'));
		const empty = Object.entries(translation)
			.filter(([key]) => key !== 'header')
			.filter(([, value]) => typeof value !== 'string' || value.trim() === '')
			.map(([key]) => key);

		expect(empty).toEqual([]);
	});
});
