/**
 * Exercises the writing endpoints against a real Papierkram account and deletes
 * everything it created again.
 *
 * THIS WRITES TO THE ACCOUNT THE TOKEN BELONGS TO. It creates one draft invoice
 * and one voucher with an attached document, reads them back to check that the
 * nested fields and the multipart upload arrived, and removes both in a
 * `finally` block. A draft invoice carries no invoice number, so deleting it
 * leaves no gap in the numbering — but run it against a test account anyway.
 *
 * What it is for: the two things the OpenAPI document cannot tell us. Whether
 * `customer: { id }` really is how a customer is attached, and whether the
 * document endpoint accepts a multipart body built the way
 * nodes/Papierkram/GenericFunctions.ts builds it.
 *
 *   PAPIERKRAM_ACCOUNT=meinefirma PAPIERKRAM_TOKEN=<token> node tools/live-write-check.mjs
 *
 * With Proton Pass, so the token never reaches the shell history:
 *
 *   pass-cli run --env-file pk.env -- node tools/live-write-check.mjs
 */
const account = process.env.PAPIERKRAM_ACCOUNT;
const token = process.env.PAPIERKRAM_TOKEN;

if (!account || !token) {
	console.error('Set PAPIERKRAM_ACCOUNT (the subdomain) and PAPIERKRAM_TOKEN.');
	process.exit(1);
}

const base = `https://${account}.papierkram.de/api/v1`;
const auth = { Accept: 'application/json', Authorization: `Bearer ${token}` };

const call = async (method, path, body) => {
	const res = await fetch(base + path, {
		method,
		headers: body === undefined ? auth : { ...auth, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const type = res.headers.get('content-type') ?? '';
	return { status: res.status, body: type.includes('json') ? await res.json() : null };
};

const report = (label, result) =>
	console.log(`   ! ${label}: HTTP ${result.status} ${result.body?.message ?? ''}`);

/**
 * vat_rate is not a percentage. The API takes the *name* of a tax rate as the
 * account has it configured — "0% Ohne USt (Kleinunternehmer)" on a
 * Kleinunternehmer account, "19%" elsewhere — and nothing lists the valid
 * names, so the only reliable source is a record that already exists.
 */
const vatRateFrom = async (listPath, itemPath) => {
	const list = await call('GET', `${listPath}?page=1&page_size=1`);
	const id = list.body?.entries?.[0]?.id;
	if (id === undefined) return undefined;
	const one = await call('GET', itemPath + id);
	const item = one.body?.line_items?.[0];
	return item === undefined ? undefined : { vatRate: item.vat_rate, category: item.category };
};

const created = { invoice: null, voucher: null };

try {
	console.log('--- prerequisites');
	const terms = await call('GET', '/income/payment_terms?page=1&page_size=1');
	const paymentTermId = terms.body?.entries?.[0]?.id;
	const companies = await call('GET', '/contact/companies?page=1&page_size=50');
	const customer = (companies.body?.entries ?? []).find((entry) => entry.contact_type === 'customer');
	const invoiceSample = await vatRateFrom('/income/invoices', '/income/invoices/');
	const voucherSample = await vatRateFrom('/expense/vouchers', '/expense/vouchers/');
	console.log(`   payment term ${paymentTermId ?? 'none'}, customer ${customer?.id ?? 'none'}`);
	console.log(`   tax rate for invoices: ${JSON.stringify(invoiceSample?.vatRate)}`);
	console.log(`   tax rate for vouchers: ${JSON.stringify(voucherSample?.vatRate)}, category ${JSON.stringify(voucherSample?.category)}`);

	console.log('--- invoice with a nested customer and a line item');
	const invoice = await call('POST', '/income/invoices', {
		name: 'API-Test n8n-nodes-papierkram',
		description: 'Automatischer Test, wird sofort wieder geloescht',
		document_date: new Date().toISOString().slice(0, 10),
		payment_term: { id: paymentTermId },
		customer: { id: customer?.id },
		line_items: [
			{ name: 'Beratung', quantity: 1, unit: 'Stunde', price: 100, vat_rate: invoiceSample?.vatRate },
		],
	});

	if (invoice.status >= 300) {
		report('create invoice', invoice);
	} else {
		created.invoice = invoice.body.id;
		console.log(`   created ${created.invoice}, state ${invoice.body.state}, number ${invoice.body.invoice_no ?? 'none (draft)'}`);
		const read = await call('GET', `/income/invoices/${created.invoice}`);
		const record = read.body ?? {};
		console.log(`   totals: net ${record.total_net}, vat ${record.total_vat}, gross ${record.total_gross}`);
		console.log(`   document_date: ${record.document_date ?? 'absent'}`);
		console.log(`   customer arrived: ${record.billing?.company ? 'yes' : 'NO — customer.id did not stick'}`);
		console.log(`   line items in the response: ${Array.isArray(record.line_items) ? record.line_items.length : 'field absent'}`);
	}

	console.log('--- voucher and multipart document upload');
	const voucher = await call('POST', '/expense/vouchers', {
		name: 'API-Test n8n-nodes-papierkram',
		provenance: 'domestic',
		document_date: new Date().toISOString().slice(0, 10),
		line_items: [
			{
				name: 'Bueromaterial',
				amount: 11.9,
				vat_rate: voucherSample?.vatRate,
				category: voucherSample?.category ?? 'Bürobedarf',
			},
		],
	});

	if (voucher.status >= 300) {
		report('create voucher', voucher);
	} else {
		created.voucher = voucher.body.id;
		console.log(`   created ${created.voucher}`);

		// The smallest thing that is still a PDF, so the account never sees a real
		// document from this check.
		const pdf = Buffer.from(
			'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
			'latin1',
		);
		const form = new FormData();
		form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'beleg-test.pdf');

		// No Content-Type header: the runtime sets it together with the boundary,
		// exactly as the node's preSend hook leaves it.
		const upload = await fetch(`${base}/expense/vouchers/${created.voucher}/documents`, {
			method: 'POST',
			headers: auth,
			body: form,
		});
		const uploadType = upload.headers.get('content-type') ?? '';
		const uploadBody = uploadType.includes('json') ? await upload.json() : null;
		console.log(`   upload: HTTP ${upload.status} ${uploadBody?.message ?? ''}`);
		if (upload.status < 300) {
			console.log(`   document keys: ${Object.keys(uploadBody ?? {}).join(',')}`);
		}
	}
} finally {
	console.log('--- cleanup');
	for (const [kind, id] of Object.entries(created)) {
		if (id === null) continue;
		const path = kind === 'invoice' ? `/income/invoices/${id}` : `/expense/vouchers/${id}`;
		const deleted = await call('DELETE', path);
		const check = await call('GET', path);
		console.log(
			`   ${kind} ${id}: delete HTTP ${deleted.status}, read back HTTP ${check.status} ${
				check.status === 404 ? '(gone)' : '(STILL THERE — remove it by hand)'
			}`,
		);
	}
}
