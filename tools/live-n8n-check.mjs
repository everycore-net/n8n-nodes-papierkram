/**
 * Exercises the node inside a running n8n, which is the only place the
 * declarative routing can actually be observed.
 *
 * The API answering correctly proves nothing about the node: pagination, the
 * `entries` unwrapping, the limit-as-page_size trick and the binary handling
 * all live in routing expressions that only the n8n runtime evaluates. This
 * builds a throwaway credential and a webhook workflow, calls the webhook,
 * looks at what comes back, and removes both again.
 *
 *   N8N_BASE=https://n8n.example.com N8N_USER=… N8N_PASS=… \
 *   PAPIERKRAM_ACCOUNT=meinefirma PAPIERKRAM_TOKEN=… node tools/live-n8n-check.mjs
 *
 * It needs an owner or admin login, because it writes credentials and
 * workflows. Everything it creates carries the name below and is deleted in a
 * `finally` block.
 */
const NAME = 'zz-papierkram-node-check';
const WEBHOOK_PATH = 'papierkram-node-check';

const base = (process.env.N8N_BASE ?? '').replace(/\/$/, '');
const { N8N_USER, N8N_PASS, PAPIERKRAM_ACCOUNT, PAPIERKRAM_TOKEN } = process.env;

if (!base || !N8N_USER || !N8N_PASS || !PAPIERKRAM_ACCOUNT || !PAPIERKRAM_TOKEN) {
	console.error('Set N8N_BASE, N8N_USER, N8N_PASS, PAPIERKRAM_ACCOUNT and PAPIERKRAM_TOKEN.');
	process.exit(1);
}

let cookie = '';

const rest = async (method, path, body) => {
	const res = await fetch(base + path, {
		method,
		headers: {
			Accept: 'application/json',
			cookie,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const type = res.headers.get('content-type') ?? '';
	return { status: res.status, body: type.includes('json') ? await res.json() : null, res };
};

/** One node's parameters are all that changes between the two probes. */
const workflowWith = (parameters, credentialId, responseData) => ({
	name: NAME,
	settings: { executionOrder: 'v1' },
	nodes: [
		{
			id: '11111111-1111-4111-8111-111111111111',
			name: 'Webhook',
			type: 'n8n-nodes-base.webhook',
			typeVersion: 2,
			position: [0, 0],
			// Without responseData the webhook answers with the first item only, which
			// would make an item count meaningless and hand back a PDF as JSON.
			parameters: { path: WEBHOOK_PATH, httpMethod: 'GET', responseMode: 'lastNode', responseData },
			webhookId: '22222222-2222-4222-8222-222222222222',
		},
		{
			id: '33333333-3333-4333-8333-333333333333',
			name: 'Papierkram',
			type: 'n8n-nodes-papierkram.papierkram',
			typeVersion: 1,
			position: [220, 0],
			parameters,
			credentials: { papierkramApi: { id: credentialId, name: NAME } },
		},
	],
	connections: { Webhook: { main: [[{ node: 'Papierkram', type: 'main', index: 0 }]] } },
});

/**
 * The upload chain. A PDF has to come from somewhere, and the account's own
 * invoice PDF is the one file we know exists, so the workflow fetches it,
 * creates a voucher, attaches the file and deletes the voucher again — all
 * through the node, which is the point: the multipart body then travels the
 * runtime's HTTP path rather than a script's fetch().
 */
const uploadWorkflow = (credentialId, invoiceId, lineItems) => {
	const node = (id, name, parameters, position) => ({
		id,
		name,
		type: 'n8n-nodes-papierkram.papierkram',
		typeVersion: 1,
		position,
		parameters,
		credentials: { papierkramApi: { id: credentialId, name: NAME } },
	});
	return {
		name: NAME,
		settings: { executionOrder: 'v1' },
		nodes: [
			{
				id: '11111111-1111-4111-8111-111111111111',
				name: 'Webhook',
				type: 'n8n-nodes-base.webhook',
				typeVersion: 2,
				position: [0, 0],
				parameters: { path: WEBHOOK_PATH, httpMethod: 'GET', responseMode: 'lastNode', responseData: 'allEntries' },
				webhookId: '22222222-2222-4222-8222-222222222222',
			},
			node('44444444-4444-4444-8444-444444444444', 'Create Voucher', {
				resource: 'voucher',
				operation: 'create',
				name: 'API-Test n8n node upload',
				provenance: 'domestic',
				lineItems,
				additionalFields: { documentDate: new Date().toISOString().slice(0, 10) },
			}, [220, 0]),
			node('55555555-5555-4555-8555-555555555555', 'Invoice PDF', {
				resource: 'invoice',
				operation: 'pdf',
				invoiceId: String(invoiceId),
			}, [440, 0]),
			node('66666666-6666-4666-8666-666666666666', 'Upload', {
				resource: 'voucherDocument',
				operation: 'create',
				voucherId: "={{ $('Create Voucher').item.json.id }}",
				binaryPropertyName: 'data',
			}, [660, 0]),
			// Reading the voucher back is the actual proof: an upload that quietly
			// did nothing would still leave the chain green.
			node('77777777-7777-4777-8777-777777777777', 'Read Voucher', {
				resource: 'voucher',
				operation: 'get',
				voucherId: "={{ $('Create Voucher').item.json.id }}",
			}, [880, 0]),
		],
		connections: {
			Webhook: { main: [[{ node: 'Create Voucher', type: 'main', index: 0 }]] },
			'Create Voucher': { main: [[{ node: 'Invoice PDF', type: 'main', index: 0 }]] },
			'Invoice PDF': { main: [[{ node: 'Upload', type: 'main', index: 0 }]] },
			Upload: { main: [[{ node: 'Read Voucher', type: 'main', index: 0 }]] },
		},
	};
};

const created = { credentialId: null, workflowId: null, voucherId: null, invoiceId: null };

/** Reads what an account-specific value has to look like off an existing record. */
const papierkramGet = async (path) =>
	(await fetch(`https://${PAPIERKRAM_ACCOUNT}.papierkram.de/api/v1${path}`, {
		headers: { Accept: 'application/json', Authorization: `Bearer ${PAPIERKRAM_TOKEN}` },
	})).json();

/** Deleting needs archiving first, which is new in n8n 2.x. */
const removeWorkflow = async (id) => {
	await rest('POST', `/rest/workflows/${id}/archive`);
	const removed = await rest('DELETE', `/rest/workflows/${id}`);
	return removed.status;
};

try {
	const login = await rest('POST', '/rest/login', {
		emailOrLdapLoginId: N8N_USER,
		email: N8N_USER,
		password: N8N_PASS,
	});
	if (login.status !== 200) throw new Error(`login failed: HTTP ${login.status}`);
	cookie = (login.res.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
	console.log('login: ok');

	const existing = await rest('GET', '/rest/workflows?includeScopes=false');
	for (const workflow of (existing.body?.data ?? existing.body ?? [])) {
		if (workflow.name !== NAME) continue;
		console.log(`leftover workflow ${workflow.id}: delete HTTP ${await removeWorkflow(workflow.id)}`);
	}

	const credential = await rest('POST', '/rest/credentials', {
		name: NAME,
		type: 'papierkramApi',
		data: { subdomain: PAPIERKRAM_ACCOUNT, apiToken: PAPIERKRAM_TOKEN },
	});
	created.credentialId = credential.body?.data?.id ?? credential.body?.id;
	console.log(`credential: HTTP ${credential.status}, id ${created.credentialId}`);

	const test = await rest('POST', `/rest/credentials/test`, {
		credentials: {
			id: created.credentialId,
			name: NAME,
			type: 'papierkramApi',
			data: { subdomain: PAPIERKRAM_ACCOUNT, apiToken: PAPIERKRAM_TOKEN },
		},
	});
	const verdict = test.body?.data ?? test.body;
	console.log(`credential test: ${verdict?.status ?? `HTTP ${test.status}`} ${verdict?.message ?? ''}`);

	const runWorkflow = async (label, definition) => {
		if (created.workflowId !== null && created.workflowId !== undefined) {
			await removeWorkflow(created.workflowId);
			created.workflowId = null;
		}
		const workflow = await rest('POST', '/rest/workflows', definition);
		const record = workflow.body?.data ?? workflow.body;
		created.workflowId = record?.id;
		if (created.workflowId === undefined) {
			console.log(`${label}: create failed HTTP ${workflow.status} ${JSON.stringify(workflow.body).slice(0, 200)}`);
			return;
		}
		const activated = await rest('POST', `/rest/workflows/${created.workflowId}/activate`, {
			versionId: record.versionId,
		});
		const stored = await rest('GET', `/rest/workflows/${created.workflowId}`);
		if (((stored.body?.data ?? stored.body)?.active) !== true) {
			console.log(`${label}: not active, HTTP ${activated.status} ${JSON.stringify(activated.body).slice(0, 200)}`);
			return;
		}
		const hook = await fetch(`${base}/webhook/${WEBHOOK_PATH}`);
		const type = hook.headers.get('content-type') ?? '';
		const payload = type.includes('json') ? await hook.json() : null;
		console.log(`${label}: HTTP ${hook.status} ${type.split(';')[0]}`);
		return payload;
	};

	const run = async (label, parameters, expectBinary = false) => {
		const responseData = expectBinary ? 'firstEntryBinary' : 'allEntries';
		if (created.workflowId !== null && created.workflowId !== undefined) {
			await removeWorkflow(created.workflowId);
			created.workflowId = null;
		}
		const workflow = await rest('POST', '/rest/workflows', workflowWith(parameters, created.credentialId, responseData));
		const record = workflow.body?.data ?? workflow.body;
		created.workflowId = record?.id;
		if (created.workflowId === undefined) {
			console.log(`${label}: create failed HTTP ${workflow.status} ${JSON.stringify(workflow.body).slice(0, 200)}`);
			return;
		}
		// n8n 2.x activates through its own route, and it insists on the version it
		// last handed out — a plain PATCH answers 200 and leaves the workflow off.
		const activated = await rest('POST', `/rest/workflows/${created.workflowId}/activate`, {
			versionId: record.versionId,
		});
		const stored = await rest('GET', `/rest/workflows/${created.workflowId}`);
		if (((stored.body?.data ?? stored.body)?.active) !== true) {
			console.log(`${label}: not active, HTTP ${activated.status} ${JSON.stringify(activated.body).slice(0, 200)}`);
			return;
		}

		const hook = await fetch(`${base}/webhook/${WEBHOOK_PATH}`);
		const type = hook.headers.get('content-type') ?? '';
		console.log(`${label}: HTTP ${hook.status} ${type.split(';')[0]}`);

		if (expectBinary) {
			const bytes = Buffer.from(await hook.arrayBuffer());
			const magic = bytes.subarray(0, 4).toString('latin1');
			console.log(`   ${bytes.length} bytes, magic ${magic} ${magic === '%PDF' ? '(a real PDF)' : '(NOT a PDF — binary handling is off)'}`);
			return;
		}

		const payload = await hook.json();
		const items = Array.isArray(payload) ? payload : [payload];
		console.log(`   ${items.length} items`);
		const first = items[0] ?? {};
		console.log(`   keys of the first item: ${Object.keys(first).slice(0, 8).join(',')}`);
		console.log(`   envelope leaked: ${Object.keys(first).includes('entries') ? 'YES — rootProperty did not unwrap' : 'no'}`);
		return items;
	};

	console.log('--- Get Many with a limit');
	const invoices = await run('invoices', {
		resource: 'invoice',
		operation: 'getAll',
		returnAll: false,
		limit: 5,
	});

	console.log('--- Get Many with Return All (paging)');
	await run('companies', { resource: 'company', operation: 'getAll', returnAll: true });

	const invoiceId = invoices?.[0]?.id;
	if (invoiceId !== undefined) {
		console.log(`--- PDF of invoice ${invoiceId}`);
		await run('pdf', { resource: 'invoice', operation: 'pdf', invoiceId: String(invoiceId) }, true);
	}
	console.log('--- Create through the node, with a nested field and a JSON array');
	{
		const terms = await papierkramGet('/income/payment_terms?page=1&page_size=1');
		const companies = await papierkramGet('/contact/companies?page=1&page_size=50');
		const customer = (companies.entries ?? []).find((entry) => entry.contact_type === 'customer');
		const sample = await papierkramGet(`/income/invoices/${invoiceId}`);
		const vatRate = sample.line_items?.[0]?.vat_rate;

		const result = await run('create invoice', {
			resource: 'invoice',
			operation: 'create',
			name: 'API-Test n8n node create',
			lineItems: JSON.stringify([
				{ name: 'Beratung', quantity: 1, unit: 'Stunde', price: 100, vat_rate: vatRate },
			]),
			additionalFields: {
				paymentTermId: terms.entries?.[0]?.id,
				customerId: customer?.id,
				documentDate: new Date().toISOString().slice(0, 10),
			},
		});

		const invoice = (Array.isArray(result) ? result[0] : result) ?? {};
		if (invoice.message !== undefined) {
			console.log(`   ! ${invoice.message}`);
		} else {
			created.invoiceId = invoice.id;
			// Read it back over the API: the node's own answer would prove only that
			// something was accepted, not what was stored.
			const stored = await papierkramGet(`/income/invoices/${invoice.id}`);
			console.log(`   invoice ${invoice.id}: state ${stored.state}, document_date ${stored.document_date}`);
			console.log(`   customer.id arrived: ${stored.billing?.company ? 'yes' : 'NO — the nested body property did not survive the routing'}`);
			console.log(`   positions: ${stored.line_items?.length ?? 0}, net ${stored.total_net}`);
		}
	}

	if (invoiceId !== undefined) {
		console.log('--- multipart upload through the node');
		const sample = await fetch(`https://${PAPIERKRAM_ACCOUNT}.papierkram.de/api/v1/expense/vouchers?page=1&page_size=1`, {
			headers: { Accept: 'application/json', Authorization: `Bearer ${PAPIERKRAM_TOKEN}` },
		}).then((r) => r.json());
		const one = await fetch(`https://${PAPIERKRAM_ACCOUNT}.papierkram.de/api/v1/expense/vouchers/${sample.entries[0].id}`, {
			headers: { Accept: 'application/json', Authorization: `Bearer ${PAPIERKRAM_TOKEN}` },
		}).then((r) => r.json());
		const position = one.line_items?.[0] ?? {};
		const lineItems = JSON.stringify([
			{ name: 'Upload-Test', amount: 1, vat_rate: position.vat_rate, category: position.category },
		]);
		const result = await runWorkflow('upload chain', uploadWorkflow(created.credentialId, invoiceId, lineItems));
		const voucher = (Array.isArray(result) ? result[0] : result) ?? {};
		if (voucher.message !== undefined) {
			console.log(`   ! ${voucher.message}`);
		} else {
			const documents = voucher.documents ?? [];
			console.log(`   voucher ${voucher.id}: ${documents.length} document(s) attached`);
			created.voucherId = voucher.id;
		}
	}
} finally {
	console.log('--- cleanup');
	if (created.workflowId !== null && created.workflowId !== undefined) {
		console.log(`   workflow ${created.workflowId}: delete HTTP ${await removeWorkflow(created.workflowId)}`);
	}
	if (created.credentialId !== null) {
		const removed = await rest('DELETE', `/rest/credentials/${created.credentialId}`);
		console.log(`   credential ${created.credentialId}: HTTP ${removed.status}`);
	}
	if (created.invoiceId) {
		const removed = await fetch(
			`https://${PAPIERKRAM_ACCOUNT}.papierkram.de/api/v1/income/invoices/${created.invoiceId}`,
			{ method: 'DELETE', headers: { Accept: 'application/json', Authorization: `Bearer ${PAPIERKRAM_TOKEN}` } },
		);
		console.log(`   invoice ${created.invoiceId}: delete HTTP ${removed.status}`);
	}
	if (created.voucherId) {
		const removed = await fetch(
			`https://${PAPIERKRAM_ACCOUNT}.papierkram.de/api/v1/expense/vouchers/${created.voucherId}`,
			{ method: 'DELETE', headers: { Accept: 'application/json', Authorization: `Bearer ${PAPIERKRAM_TOKEN}` } },
		);
		console.log(`   voucher ${created.voucherId}: delete HTTP ${removed.status}`);
	}
}
