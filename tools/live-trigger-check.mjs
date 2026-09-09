/**
 * Watches the trigger do its job in a running n8n.
 *
 * The watermark logic only means something over time: the first poll has to
 * adopt the account's current state silently, and the next one has to fire for
 * exactly the record that appeared in between. That cannot be checked in a unit
 * test, because "in between" is the whole point.
 *
 * It runs for about three minutes, since a poll interval of one minute is the
 * shortest n8n offers.
 *
 *   N8N_BASE=… N8N_USER=… N8N_PASS=… PAPIERKRAM_ACCOUNT=… PAPIERKRAM_TOKEN=… \
 *   node tools/live-trigger-check.mjs
 *
 * It creates a company in Papierkram to have something to fire on, and removes
 * it, the workflow and the credential in a `finally` block.
 */
const NAME = 'zz-papierkram-trigger-check';

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

const papierkram = async (method, path, body) => {
	const res = await fetch(`https://${PAPIERKRAM_ACCOUNT}.papierkram.de/api/v1${path}`, {
		method,
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${PAPIERKRAM_TOKEN}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const type = res.headers.get('content-type') ?? '';
	return { status: res.status, body: type.includes('json') ? await res.json() : null };
};

const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const executionsOf = async (workflowId) => {
	const res = await rest('GET', `/rest/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId }))}`);
	const data = res.body?.data ?? res.body;
	return data?.results ?? data ?? [];
};

const created = { credentialId: null, workflowId: null, companyId: null };

const removeWorkflow = async (id) => {
	await rest('POST', `/rest/workflows/${id}/archive`);
	return (await rest('DELETE', `/rest/workflows/${id}`)).status;
};

try {
	const login = await rest('POST', '/rest/login', {
		emailOrLdapLoginId: N8N_USER,
		email: N8N_USER,
		password: N8N_PASS,
	});
	if (login.status !== 200) throw new Error(`login failed: HTTP ${login.status}`);
	cookie = (login.res.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');

	const stale = await rest('GET', '/rest/workflows?includeScopes=false');
	for (const workflow of stale.body?.data ?? stale.body ?? []) {
		if (workflow.name === NAME) await removeWorkflow(workflow.id);
	}

	const credential = await rest('POST', '/rest/credentials', {
		name: NAME,
		type: 'papierkramApi',
		data: { subdomain: PAPIERKRAM_ACCOUNT, apiToken: PAPIERKRAM_TOKEN },
	});
	created.credentialId = credential.body?.data?.id ?? credential.body?.id;

	// A manual execution has its own contract: show the newest records, spend one
	// request, move nothing. It runs through the same route the editor uses.
	console.log('--- manual execution');
	{
		const nodes = [
			{
				id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				name: 'Papierkram Trigger',
				type: '@everyc0re/n8n-nodes-papierkram.papierkramTrigger',
				typeVersion: 1,
				position: [0, 0],
				parameters: { pollTimes: { item: [{ mode: 'everyHour' }] }, resource: 'company', mode: 'created' },
				credentials: { papierkramApi: { id: created.credentialId, name: NAME } },
			},
		];
		const draft = await rest('POST', '/rest/workflows', {
			name: NAME,
			settings: { executionOrder: 'v1' },
			nodes,
			connections: {},
		});
		const draftRecord = draft.body?.data ?? draft.body;
		const run = await rest('POST', `/rest/workflows/${draftRecord.id}/run`, {
			workflowData: { ...draftRecord, nodes, connections: {} },
			triggerToStartFrom: { name: 'Papierkram Trigger' },
			startNodes: [],
		});
		const executionId = (run.body?.data ?? run.body)?.executionId;
		let delivered = null;
		for (let attempt = 0; attempt < 10 && delivered === null; attempt += 1) {
			await wait(2);
			const detail = await rest('GET', `/rest/executions/${executionId}`);
			const body = detail.body?.data ?? detail.body;
			if (body?.status === 'success' || body?.finished === true) {
				const raw = JSON.stringify(detail.body ?? {}).replace(/\\"/g, '"');
				delivered = (raw.match(/"contact_type"/g) ?? []).length;
			}
		}
		const stored = await rest('GET', `/rest/workflows/${draftRecord.id}`);
		const staticData = (stored.body?.data ?? stored.body)?.staticData ?? null;
		console.log(`   delivered ${delivered} record(s) ${delivered !== null && delivered <= 10 ? '(preview capped at ten)' : '(MORE THAN THE PREVIEW)'}`);
		console.log(`   watermark after the manual run: ${JSON.stringify(staticData)} ${staticData === null ? '(untouched, as it should be)' : '(MOVED — a manual look consumed records)'}`);
		await removeWorkflow(draftRecord.id);
	}

	const definition = {
		name: NAME,
		settings: { executionOrder: 'v1' },
		nodes: [
			{
				id: '88888888-8888-4888-8888-888888888888',
				name: 'Papierkram Trigger',
				type: '@everyc0re/n8n-nodes-papierkram.papierkramTrigger',
				typeVersion: 1,
				position: [0, 0],
				parameters: {
					pollTimes: { item: [{ mode: 'everyMinute' }] },
					resource: 'company',
					mode: 'created',
				},
				credentials: { papierkramApi: { id: created.credentialId, name: NAME } },
			},
			{
				id: '99999999-9999-4999-8999-999999999999',
				name: 'No Operation',
				type: 'n8n-nodes-base.noOp',
				typeVersion: 1,
				position: [220, 0],
				parameters: {},
			},
		],
		connections: {
			'Papierkram Trigger': { main: [[{ node: 'No Operation', type: 'main', index: 0 }]] },
		},
	};

	const workflow = await rest('POST', '/rest/workflows', definition);
	const record = workflow.body?.data ?? workflow.body;
	created.workflowId = record?.id;
	const activated = await rest('POST', `/rest/workflows/${created.workflowId}/activate`, {
		versionId: record.versionId,
	});
	const stored = await rest('GET', `/rest/workflows/${created.workflowId}`);
	console.log(`workflow ${created.workflowId}: activate HTTP ${activated.status}, active=${(stored.body?.data ?? stored.body)?.active}`);

	console.log('--- first poll must adopt the state and stay quiet');
	await wait(80);
	const afterFirst = await executionsOf(created.workflowId);
	console.log(`   executions after the first poll: ${afterFirst.length} ${afterFirst.length === 0 ? '(quiet, as it should be)' : '(FIRED — it replayed the account)'}`);

	console.log('--- create a company, the next poll must fire for it');
	const company = await papierkram('POST', '/contact/companies', {
		name: 'API-Test n8n Trigger',
		contact_type: 'customer',
	});
	created.companyId = company.body?.id;
	console.log(`   company ${created.companyId} created`);

	let fired = [];
	for (let attempt = 0; attempt < 4 && fired.length === 0; attempt += 1) {
		await wait(35);
		fired = await executionsOf(created.workflowId);
		console.log(`   +${(attempt + 1) * 35}s: ${fired.length} execution(s)`);
	}

	if (fired.length > 0) {
		const detail = await rest('GET', `/rest/executions/${fired[0].id}`);
		// n8n serialises run data with flatted and hands it back as a JSON string
		// *inside* the JSON response, so it arrives with every quote escaped and
		// its objects turned into an index table. Searching the flattened text is
		// enough for the one question that matters — did this record come through
		// — as long as the escaping is undone first.
		const raw = JSON.stringify(detail.body ?? {}).replace(/\\"/g, '"');
		const hasId = raw.includes(`"id":${created.companyId}`);
		const hasName = raw.includes('API-Test n8n Trigger');
		console.log(`   execution ${fired[0].id}: status ${fired[0].status}`);
		console.log(`   carries the new company id ${created.companyId}: ${hasId}`);
		console.log(`   carries its name: ${hasName}`);
		const others = (raw.match(/"contact_type"/g) ?? []).length;
		console.log(`   companies in the payload: ${others} ${others === 1 ? '(only the new one)' : '(more than the new one — the watermark is leaking)'}`);
	} else {
		console.log('   nothing fired — the watermark or the poll interval is wrong');
	}
} finally {
	console.log('--- cleanup');
	if (created.workflowId) console.log(`   workflow: HTTP ${await removeWorkflow(created.workflowId)}`);
	if (created.credentialId) {
		console.log(`   credential: HTTP ${(await rest('DELETE', `/rest/credentials/${created.credentialId}`)).status}`);
	}
	if (created.companyId) {
		console.log(`   company ${created.companyId}: HTTP ${(await papierkram('DELETE', `/contact/companies/${created.companyId}`)).status}`);
	}
}
