import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	IDataObject,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';

/**
 * Polls Papierkram for records that appeared or changed since the last run.
 *
 * Papierkram has no webhooks, so polling is the only way in, and it has no
 * "changed since" filter either. What it does have is a sort order: asking for
 * the newest records first and stopping at the watermark keeps the cost of a
 * poll proportional to what actually changed rather than to the size of the
 * account. That matters here — requests are metered in credits against a
 * monthly budget, not merely rate limited.
 *
 * Two watermarks, because the API exposes two different notions of recency and
 * not every resource has both:
 *
 *   New Records     highest id seen. Works everywhere. An edit does not change
 *                   an id, so edits do not fire it.
 *   New and Updated highest updated_at seen. Only for the resources that carry
 *                   the field — invoices, estimates and vouchers do not, and
 *                   the option is hidden for them.
 *
 * The sort order is verified rather than trusted: order_by is documented as a
 * free-form string with no list of accepted fields, and an unknown one answers
 * 500. If the records do not come back in descending order, the poll walks the
 * pages instead of quietly skipping records.
 */

interface ResourceDefinition {
	path: string;
	label: string;
	hasUpdatedAt: boolean;
}

const RESOURCES: Record<string, ResourceDefinition> = {
	bankTransaction: { path: '/banking/transactions', label: 'bank transactions', hasUpdatedAt: true },
	company: { path: '/contact/companies', label: 'companies', hasUpdatedAt: true },
	estimate: { path: '/income/estimates', label: 'estimates', hasUpdatedAt: false },
	invoice: { path: '/income/invoices', label: 'invoices', hasUpdatedAt: false },
	project: { path: '/projects', label: 'projects', hasUpdatedAt: true },
	proposition: { path: '/income/propositions', label: 'propositions', hasUpdatedAt: true },
	task: { path: '/tracker/tasks', label: 'tasks', hasUpdatedAt: true },
	timeEntry: { path: '/tracker/time_entries', label: 'time entries', hasUpdatedAt: true },
	voucher: { path: '/expense/vouchers', label: 'vouchers', hasUpdatedAt: false },
};

const UPDATABLE = Object.entries(RESOURCES)
	.filter(([, definition]) => definition.hasUpdatedAt)
	.map(([name]) => name);

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export class PapierkramTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Papierkram Trigger',
		name: 'papierkramTrigger',
		icon: { light: 'file:papierkram.svg', dark: 'file:papierkram.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["resource"]}}',
		description: 'Starts a workflow for Papierkram records that appeared or changed since the last poll',
		defaults: {
			name: 'Papierkram Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'papierkramApi',
				required: true,
			},
		],
		properties: [
			{
				displayName:
					'Every poll costs credits from the account\'s monthly API budget, whether or not it finds anything. Papierkram has no webhooks, so this is the only way in.',
				name: 'quotaNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Bank Transaction', value: 'bankTransaction' },
					{ name: 'Company', value: 'company' },
					{ name: 'Estimate', value: 'estimate' },
					{ name: 'Invoice', value: 'invoice' },
					{ name: 'Project', value: 'project' },
					{ name: 'Proposition', value: 'proposition' },
					{ name: 'Task', value: 'task' },
					{ name: 'Time Entry', value: 'timeEntry' },
					{ name: 'Voucher', value: 'voucher' },
				],
				default: 'invoice',
				description: 'Which records to watch',
			},
			{
				displayName: 'Trigger On',
				name: 'mode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'New Records',
						value: 'created',
						description: 'Records with a higher ID than the highest one seen before',
					},
					{
						name: 'New and Updated Records',
						value: 'updated',
						description: 'Records whose updated_at is newer than the newest one seen before',
					},
				],
				default: 'created',
				displayOptions: { show: { resource: UPDATABLE } },
			},
			{
				displayName:
					'Invoices, estimates and vouchers do not carry a change timestamp in the API, so this trigger only sees new ones. An edit to an existing record cannot be detected.',
				name: 'createdOnlyNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['invoice', 'estimate', 'voucher'] } },
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const resource = this.getNodeParameter('resource') as string;
		const definition = RESOURCES[resource];
		if (definition === undefined) {
			throw new NodeOperationError(this.getNode(), `Unknown resource "${resource}"`);
		}

		const mode = definition.hasUpdatedAt ? (this.getNodeParameter('mode', 'created') as string) : 'created';
		const sortField = mode === 'updated' ? 'updated_at' : 'id';

		/** Both watermarks are numbers, so one comparison serves both modes. */
		const rank = (entry: IDataObject): number => {
			if (mode === 'updated') {
				const parsed = Date.parse(String(entry.updated_at ?? ''));
				return Number.isNaN(parsed) ? 0 : parsed;
			}
			return Number(entry.id ?? 0);
		};

		const credentials = await this.getCredentials('papierkramApi');
		const baseURL = `https://${credentials.subdomain as string}.papierkram.de/api/v1`;
		const staticData = this.getWorkflowStaticData('node');
		const watermarkKey = `${mode}_${resource}`;
		const known = (staticData[watermarkKey] as number | undefined) ?? 0;

		const request = async (page: number, sorted: boolean): Promise<IDataObject> => {
			const options: IHttpRequestOptions = {
				baseURL,
				url: definition.path,
				method: 'GET',
				headers: { Accept: 'application/json' },
				qs: {
					page,
					page_size: PAGE_SIZE,
					...(sorted ? { order_by: sortField, order_direction: 'desc' } : {}),
				},
				json: true,
			};
			try {
				return (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'papierkramApi',
					options,
				)) as IDataObject;
			} catch (error) {
				if ((error as { statusCode?: number }).statusCode === 429) {
					throw new NodeApiError(this.getNode(), error as JsonObject, {
						message: 'Papierkram refused the request: the monthly API credit quota is used up',
						description:
							'The quota resets at the start of the next month. Until then a longer poll interval is the only lever, because every poll costs credits even when it finds nothing.',
					});
				}
				throw new NodeApiError(this.getNode(), error as JsonObject);
			}
		};

		const entriesOf = (body: IDataObject): IDataObject[] =>
			Array.isArray(body.entries) ? (body.entries as IDataObject[]) : [];

		const isDescending = (entries: IDataObject[]): boolean =>
			entries.every((entry, index) => index === 0 || rank(entries[index - 1]) >= rank(entry));

		const first = await request(1, true);
		const firstEntries = entriesOf(first);
		const sortHolds = firstEntries.length > 0 && isDescending(firstEntries);

		const newer: IDataObject[] = firstEntries.filter((entry) => rank(entry) > known);
		let page = 1;
		let hasMore = first.has_more === true;

		if (sortHolds) {
			// Newest first: the first known record ends the search, everything
			// behind it is older still.
			while (hasMore && newer.length === page * PAGE_SIZE && page < MAX_PAGES) {
				page += 1;
				const body = await request(page, true);
				const found = entriesOf(body).filter((entry) => rank(entry) > known);
				newer.push(...found);
				hasMore = body.has_more === true && found.length === PAGE_SIZE;
			}
		} else {
			// The endpoint ignored order_by. Correct still beats cheap: walk the
			// pages, but stop rather than spend the whole credit budget.
			while (hasMore && page < MAX_PAGES) {
				page += 1;
				const body = await request(page, false);
				newer.push(...entriesOf(body).filter((entry) => rank(entry) > known));
				hasMore = body.has_more === true;
			}
			if (hasMore) {
				throw new NodeOperationError(
					this.getNode(),
					`Papierkram returned more than ${MAX_PAGES * PAGE_SIZE} ${definition.label} and ignored the requested sort order`,
					{
						description:
							'Telling new records from old ones this way would cost the whole API credit budget. Read the records with the Papierkram node and a date filter instead.',
					},
				);
			}
		}

		if (this.getMode() === 'manual') {
			// A manual execution shows what the trigger sees without consuming the
			// records: the watermark stays where it is.
			const preview = firstEntries.length > 0 ? firstEntries : newer;
			return preview.length === 0 ? null : [this.helpers.returnJsonArray(preview.slice(0, 10))];
		}

		staticData[watermarkKey] = newer.reduce((highest, entry) => Math.max(highest, rank(entry)), known);

		// First automatic poll: adopt the current state instead of replaying the
		// whole account into the workflow.
		if (known === 0 || newer.length === 0) return null;

		newer.sort((left, right) => rank(left) - rank(right));
		return [this.helpers.returnJsonArray(newer)];
	}
}
