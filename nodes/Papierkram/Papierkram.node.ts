import { NodeConnectionTypes } from 'n8n-workflow';
import type { INodeType, INodeTypeDescription } from 'n8n-workflow';

import { resourceOptions, resourceProperties } from './descriptions';

/**
 * Action node for the Papierkram API.
 *
 * Declarative style: every operation is a route, there is no transport code of
 * our own. The property lists under descriptions/ are generated from the
 * vendored OpenAPI document, so a field named here is a field the API
 * documents — see tools/generate-descriptions.mjs.
 *
 * List operations return the entries of the paginated envelope rather than the
 * envelope itself, so a following node sees one item per record. With "Return
 * All" off, page_size carries the limit, which keeps the credit cost of a
 * request proportional to what the workflow actually asked for.
 */
export class Papierkram implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Papierkram',
		name: 'papierkram',
		icon: { light: 'file:papierkram.svg', dark: 'file:papierkram.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Work with invoices, vouchers, projects and time tracking in Papierkram',
		defaults: {
			name: 'Papierkram',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'papierkramApi',
				required: true,
			},
		],
		requestDefaults: {
			baseURL: '=https://{{$credentials.subdomain}}.papierkram.de/api/v1',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		},
		properties: [resourceOptions, ...resourceProperties],
	};
}
