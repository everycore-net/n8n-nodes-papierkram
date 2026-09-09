import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	IDataObject,
	JsonObject,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';

/**
 * Polls Papierkram for records that appeared since the last run.
 *
 * Papierkram has no webhooks and no "changed since" filter, so this is a *new
 * record* trigger and not a *changed record* one: the watermark is the highest
 * id seen so far, and editing an existing invoice does not change its id.
 *
 * The efficient path asks the API for the newest records first
 * (order_by=id&order_direction=desc) and stops at the watermark. order_by is
 * documented as a plain string with no list of accepted fields, so the response
 * is checked: if the ids do not come back in descending order the endpoint
 * ignored the parameter, and the poll falls back to walking every page. That
 * fallback is correct but expensive — each request costs API credits from a
 * monthly budget — so it is capped and reported rather than run silently.
 */

const ENDPOINTS: Record<string, { path: string; label: string }> = {
	bankTransaction: { path: '/banking/transactions', label: 'bank transactions' },
	company: { path: '/contact/companies', label: 'companies' },
	estimate: { path: '/income/estimates', label: 'estimates' },
	invoice: { path: '/income/invoices', label: 'invoices' },
	project: { path: '/projects', label: 'projects' },
	proposition: { path: '/income/propositions', label: 'propositions' },
	task: { path: '/tracker/tasks', label: 'tasks' },
	timeEntry: { path: '/tracker/time_entries', label: 'time entries' },
	voucher: { path: '/expense/vouchers', label: 'vouchers' },
};

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export class PapierkramTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Papierkram Trigger',
		name: 'papierkramTrigger',
		icon: { light: 'file:papierkram.svg', dark: 'file:papierkram.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{"New " + $parameter["resource"]}}',
		description: 'Starts a workflow for Papierkram records that appeared since the last poll',
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
					'Fires for records with a higher ID than the highest one seen before. Papierkram has no webhooks and no "changed since" filter, so changes to existing records do not fire this trigger.',
				name: 'behaviourNotice',
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
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const resource = this.getNodeParameter('resource') as string;
		const endpoint = ENDPOINTS[resource];
		if (endpoint === undefined) {
			throw new NodeOperationError(this.getNode(), `Unknown resource "${resource}"`);
		}

		const credentials = await this.getCredentials('papierkramApi');
		const baseURL = `https://${credentials.subdomain as string}.papierkram.de/api/v1`;
		const staticData = this.getWorkflowStaticData('node');
		const watermarkKey = `lastId_${resource}`;
		const knownId = (staticData[watermarkKey] as number | undefined) ?? 0;
		const isManualRun = this.getMode() === 'manual';

		const request = async (page: number, descending: boolean): Promise<IDataObject> => {
			const options: IHttpRequestOptions = {
				baseURL,
				url: endpoint.path,
				method: 'GET',
				headers: { Accept: 'application/json' },
				qs: {
					page,
					page_size: PAGE_SIZE,
					...(descending ? { order_by: 'id', order_direction: 'desc' } : {}),
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
							'The quota resets at the start of the next month. Until then, polling less often is the only lever — every poll costs credits even when it finds nothing.',
					});
				}
				throw new NodeApiError(this.getNode(), error as JsonObject);
			}
		};

		const entriesOf = (body: IDataObject): IDataObject[] =>
			Array.isArray(body.entries) ? (body.entries as IDataObject[]) : [];

		const idOf = (entry: IDataObject): number => Number(entry.id ?? 0);

		const isDescending = (entries: IDataObject[]): boolean =>
			entries.every((entry, index) => index === 0 || idOf(entries[index - 1]) >= idOf(entry));

		const first = await request(1, true);
		const firstEntries = entriesOf(first);

		let candidates: IDataObject[];

		if (isDescending(firstEntries) && firstEntries.length > 0) {
			candidates = firstEntries.filter((entry) => idOf(entry) > knownId);
			let page = 1;
			let hasMore = first.has_more === true;
			// Only keep paging while the whole page was new: the first known id
			// means everything behind it is known too.
			while (hasMore && candidates.length === page * PAGE_SIZE && page < MAX_PAGES) {
				page += 1;
				const body = await request(page, true);
				const newer = entriesOf(body).filter((entry) => idOf(entry) > knownId);
				candidates.push(...newer);
				hasMore = body.has_more === true && newer.length === PAGE_SIZE;
			}
		} else {
			// order_by was ignored, or the account is empty. Walk the pages.
			candidates = firstEntries.filter((entry) => idOf(entry) > knownId);
			let page = 1;
			let hasMore = first.has_more === true;
			while (hasMore && page < MAX_PAGES) {
				page += 1;
				const body = await request(page, false);
				candidates.push(...entriesOf(body).filter((entry) => idOf(entry) > knownId));
				hasMore = body.has_more === true;
			}
			if (hasMore) {
				throw new NodeOperationError(
					this.getNode(),
					`Papierkram returned more than ${MAX_PAGES * PAGE_SIZE} ${endpoint.label} without honouring the sort order`,
					{
						description:
							'The trigger cannot tell new records from old ones this way without spending the whole API credit budget. Use the Papierkram node with a date filter instead.',
					},
				);
			}
		}

		const highestId = candidates.reduce((highest, entry) => Math.max(highest, idOf(entry)), knownId);

		if (isManualRun) {
			// A manual run must show the user what the trigger sees, so it returns
			// the newest records without moving the watermark.
			const preview = firstEntries.length > 0 ? firstEntries : candidates;
			if (preview.length === 0) return null;
			return [this.helpers.returnJsonArray(preview.slice(0, 10))];
		}

		staticData[watermarkKey] = highestId;

		if (knownId === 0) {
			// First automatic poll: adopt the current state instead of replaying the
			// whole account into the workflow.
			return null;
		}

		if (candidates.length === 0) return null;

		candidates.sort((a, b) => idOf(a) - idOf(b));
		return [this.helpers.returnJsonArray(candidates)];
	}
}
