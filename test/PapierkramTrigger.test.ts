import { describe, expect, it } from 'vitest';
import type { IDataObject, IHttpRequestOptions, INodeExecutionData, IPollFunctions } from 'n8n-workflow';

import { PapierkramTrigger } from '../nodes/PapierkramTrigger/PapierkramTrigger.node';

/**
 * The trigger is the one place in this package with logic of its own, and its
 * contract is about cost as much as about correctness: a poll that finds
 * nothing must not spend a page of API credits, and a first poll must not
 * replay the account into the workflow.
 *
 * Everything here is driven through a fake IPollFunctions that records the
 * requests, so the assertions can be about *how many* calls were made, not only
 * about what came back.
 */

interface Page {
	entries: IDataObject[];
	has_more?: boolean;
}

interface HarnessOptions {
	/** Answers keyed by page number; `sorted` says whether order_by was sent. */
	pages: (page: number, sorted: boolean) => Page;
	resource?: string;
	mode?: string;
	runMode?: 'manual' | 'trigger';
	staticData?: IDataObject;
	fail?: (page: number) => unknown;
}

const harness = (options: HarnessOptions) => {
	const requests: IHttpRequestOptions[] = [];
	const staticData: IDataObject = options.staticData ?? {};

	const context = {
		getNodeParameter: (name: string, fallback?: unknown) => {
			if (name === 'resource') return options.resource ?? 'invoice';
			if (name === 'mode') return options.mode ?? fallback ?? 'created';
			return fallback;
		},
		getCredentials: async () => ({ subdomain: 'demo', apiToken: 'token' }),
		getWorkflowStaticData: () => staticData,
		getMode: () => options.runMode ?? 'trigger',
		getNode: () => ({
			id: 'test',
			name: 'Papierkram Trigger',
			type: 'n8n-nodes-papierkram.papierkramTrigger',
			typeVersion: 1,
			position: [0, 0] as [number, number],
			parameters: {},
		}),
		helpers: {
			httpRequestWithAuthentication: async (_credentialType: string, request: IHttpRequestOptions) => {
				requests.push(request);
				const page = Number(request.qs?.page ?? 1);
				const failure = options.fail?.(page);
				if (failure !== undefined) throw failure;
				return options.pages(page, request.qs?.order_by !== undefined);
			},
			returnJsonArray: (items: IDataObject[]): INodeExecutionData[] =>
				items.map((json) => ({ json })),
		},
	};

	return {
		requests,
		staticData,
		poll: async () =>
			(await PapierkramTrigger.prototype.poll.call(context as unknown as IPollFunctions)) as
				| INodeExecutionData[][]
				| null,
	};
};

/** Newest first, the way the API answers when order_by is honoured. */
const descending = (...ids: number[]): IDataObject[] => ids.map((id) => ({ id, type: 'invoice' }));

const idsOf = (result: INodeExecutionData[][] | null): number[] =>
	(result?.[0] ?? []).map((item) => Number(item.json.id));

describe('first poll', () => {
	it('adopts the newest record with a single request and emits nothing', async () => {
		const { poll, requests, staticData } = harness({
			pages: () => ({ entries: descending(...Array.from({ length: 100 }, (_, i) => 500 - i)), has_more: true }),
		});

		expect(await poll()).toBeNull();
		// The whole point: a full page of unseen records and more behind it, and
		// it still costs exactly one request.
		expect(requests).toHaveLength(1);
		expect(staticData.created_invoice).toBe(500);
	});

	it('walks the pages when the endpoint ignores the sort order, because page one proves nothing', async () => {
		const { poll, requests, staticData } = harness({
			pages: (page) => ({ entries: descending(1 + page, 5 + page, 3 + page), has_more: page < 3 }),
		});

		expect(await poll()).toBeNull();
		expect(requests.length).toBeGreaterThan(1);
		expect(staticData.created_invoice).toBe(8);
	});
});

describe('manual execution', () => {
	it('shows the newest records, spends one request and leaves the watermark alone', async () => {
		const { poll, requests, staticData } = harness({
			runMode: 'manual',
			staticData: { created_invoice: 3 },
			pages: () => ({ entries: descending(...Array.from({ length: 100 }, (_, i) => 100 - i)), has_more: true }),
		});

		const result = await poll();
		expect(requests).toHaveLength(1);
		expect(result?.[0]).toHaveLength(10);
		expect(idsOf(result)[0]).toBe(100);
		expect(staticData.created_invoice).toBe(3);
	});

	it('returns null on an empty account instead of an empty batch', async () => {
		const { poll } = harness({ runMode: 'manual', pages: () => ({ entries: [] }) });
		expect(await poll()).toBeNull();
	});
});

describe('new records', () => {
	it('emits only what is above the watermark, oldest first', async () => {
		const { poll, requests, staticData } = harness({
			staticData: { created_invoice: 10 },
			pages: () => ({ entries: descending(13, 12, 11, 10, 9), has_more: false }),
		});

		const result = await poll();
		expect(idsOf(result)).toEqual([11, 12, 13]);
		expect(requests).toHaveLength(1);
		expect(staticData.created_invoice).toBe(13);
	});

	it('says nothing and stops after one request when there is nothing new', async () => {
		const { poll, requests, staticData } = harness({
			staticData: { created_invoice: 42 },
			pages: () => ({ entries: descending(42, 41, 40), has_more: true }),
		});

		expect(await poll()).toBeNull();
		expect(requests).toHaveLength(1);
		expect(staticData.created_invoice).toBe(42);
	});

	it('keeps paging while every record on the page is new', async () => {
		const newest = Array.from({ length: 100 }, (_, i) => 300 - i);
		const older = Array.from({ length: 100 }, (_, i) => 200 - i);
		const { poll, requests } = harness({
			staticData: { created_invoice: 150 },
			pages: (page) =>
				page === 1
					? { entries: descending(...newest), has_more: true }
					: { entries: descending(...older), has_more: false },
		});

		const result = await poll();
		expect(requests).toHaveLength(2);
		expect(result?.[0]).toHaveLength(150);
		expect(idsOf(result)[0]).toBe(151);
	});
});

describe('updated records', () => {
	it('ranks by updated_at and asks the API to sort by it', async () => {
		const stamp = (iso: string, id: number): IDataObject => ({ id, updated_at: iso });
		const { poll, requests, staticData } = harness({
			resource: 'company',
			mode: 'updated',
			staticData: { updated_company: Date.parse('2026-09-01T10:00:00.000+02:00') },
			pages: () => ({
				entries: [
					stamp('2026-09-03T10:00:00.000+02:00', 7),
					stamp('2026-09-02T10:00:00.000+02:00', 4),
					stamp('2026-09-01T10:00:00.000+02:00', 9),
				],
				has_more: false,
			}),
		});

		const result = await poll();
		expect(requests[0].qs?.order_by).toBe('updated_at');
		expect(idsOf(result)).toEqual([4, 7]);
		expect(staticData.updated_company).toBe(Date.parse('2026-09-03T10:00:00.000+02:00'));
	});

	it('falls back to the id watermark for a resource without updated_at', async () => {
		const { poll, requests, staticData } = harness({
			resource: 'voucher',
			mode: 'updated',
			staticData: { created_voucher: 2 },
			pages: () => ({ entries: descending(4, 3, 2), has_more: false }),
		});

		const result = await poll();
		expect(requests[0].qs?.order_by).toBe('id');
		expect(idsOf(result)).toEqual([3, 4]);
		expect(staticData.created_voucher).toBe(4);
	});
});

describe('an endpoint that ignores order_by', () => {
	it('walks the pages rather than trusting the first one', async () => {
		const { poll, requests } = harness({
			staticData: { created_invoice: 5 },
			pages: (page) => ({ entries: descending(1, 9, 4), has_more: page < 3 }),
		});

		const result = await poll();
		expect(requests.length).toBe(3);
		expect(idsOf(result)).toEqual([9, 9, 9]);
	});

	it('stops with an explanation instead of spending the whole credit budget', async () => {
		const { poll } = harness({
			staticData: { created_invoice: 5 },
			pages: () => ({ entries: descending(1, 9, 4), has_more: true }),
		});

		await expect(poll()).rejects.toThrow(/ignored the requested sort order/);
	});
});

describe('errors', () => {
	it('turns a 429 into a message about the monthly credit budget', async () => {
		const { poll } = harness({
			pages: () => ({ entries: [] }),
			fail: () => ({ statusCode: 429, message: 'Too Many Requests' }),
		});

		await expect(poll()).rejects.toThrow(/monthly API credit quota/);
	});

	it('rejects an unknown resource before making any request', async () => {
		const { poll, requests } = harness({ resource: 'nonsense', pages: () => ({ entries: [] }) });

		await expect(poll()).rejects.toThrow(/Unknown resource/);
		expect(requests).toHaveLength(0);
	});
});
