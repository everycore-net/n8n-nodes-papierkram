# n8n-nodes-papierkram

n8n community node for the [Papierkram.de](https://www.papierkram.de) API — invoices, estimates,
vouchers, contacts, projects and time tracking.

This is an independent open-source package. It is not built or endorsed by Papierkram GmbH.

## Installation

Self-hosted n8n, as an owner or admin: **Settings → Community nodes → Install** and enter
`n8n-nodes-papierkram`.

Manually, next to your n8n installation:

```bash
npm install n8n-nodes-papierkram
```

## Credentials

1. In Papierkram open **Einstellungen → API** and create a token. The page is only available in the
   **M** and **L** packages — the API is not part of the smaller ones.
2. In n8n create a **Papierkram API** credential:
   - **Account** — the subdomain, so `meinefirma` for `https://meinefirma.papierkram.de`.
   - **API Token** — the token from step 1.

The credential test calls `GET /info`, the cheapest endpoint. If it fails, the account name or the
token is wrong; a permission problem on a single resource shows up later, on that resource.

## Nodes

### Papierkram

| Resource | Operations |
| --- | --- |
| Bank Connection | Get, Get Many |
| Bank Transaction | Get, Get Many |
| Company | Get, Get Many, Create, Update, Delete, Archive, Unarchive |
| Contact Person | Get, Get Many, Create, Update, Delete |
| Custom Attribute | Get, Get Many, Create, Update, Delete, Archive, Unarchive |
| Estimate | Get, Get Many, Create, Update, Delete, Archive, Unarchive, Cancel, Deliver, PDF |
| Info | Get |
| Invoice | Get, Get Many, Create, Update, Delete, Archive, Unarchive, Cancel, Deliver, PDF |
| Payment Term | Get, Get Many |
| Project | Get, Get Many, Create, Update, Delete, Archive, Unarchive |
| Proposition | Get, Get Many, Create, Update, Delete, Archive, Unarchive |
| Task | Get, Get Many, Create, Update, Delete, Archive, Unarchive |
| Time Entry | Get, Get Many, Create, Update, Delete, Archive, Unarchive |
| User | Get, Get Many |
| Voucher | Get, Get Many, Create, Update, Delete, Archive, Unarchive, Cancel, Cancel With Reverse Entry, Pay, PDF |
| Voucher Document | Create (file upload), Delete |

**Get Many** returns one item per record, not the paginated envelope. With *Return All* off, the
limit becomes `page_size`, so asking for 10 invoices costs one request for 10 records.

**PDF** puts the document in the binary property `data`.

The node is marked `usableAsTool`, so n8n also offers it as **Papierkram Tool** to AI agent nodes.

Verified against n8n **2.35.5** and a live account on 9 September 2026 — see [TESTING.md](TESTING.md)
for what was checked and what the API does that its own specification does not mention.

Nested API fields are flat parameters with their path as the name: the customer of an invoice is
`Customer ID`, which is sent as `customer.id`. Fields the API documents as arrays or objects —
`line_items` on an invoice, `custom_attributes` anywhere — take JSON, which is what an expression
from an earlier node produces anyway.

### Papierkram Trigger

Polls one resource and starts the workflow for records that appeared — or changed — since the last
run. Papierkram has no webhooks, so polling is the only way in.

| Trigger on | Watermark | Available for |
| --- | --- | --- |
| New Records | highest ID seen | every resource |
| New and Updated Records | newest `updated_at` seen | bank transactions, companies, projects, propositions, tasks, time entries |

Invoices, estimates and vouchers do not carry `updated_at` in the API, so for those the trigger can
only ever see new records — an edit to an existing invoice is invisible. The node hides the option
rather than offering something it cannot deliver.

The first automatic poll adopts the current state and emits nothing, so switching a workflow on does
not replay the whole account. A manual execution shows the newest records without moving the
watermark.

## What the API cannot do

Worth knowing before designing a workflow around it — these are limits of the Papierkram API, not of
this node:

- The API is documented as **BETA** and is available in the **M** and **L** packages only.
- Requests are metered in **credits**: 10,000 per month for M, 20,000 for L. Every response carries
  `X-Remaining-Quota`; once the budget is spent the API answers **429** until the next month. A
  one-minute poll on several resources is a real budget decision, not a free knob.
- There are **no webhooks**. Polling is the only way in.
- `order_by` is documented as a free-form string with no list of accepted fields. `id` and
  `updated_at` work (verified against a live account on 9 September 2026); a field the endpoint does
  not know answers **HTTP 500**, not a validation error. The trigger therefore checks that the
  records really did come back in descending order and walks the pages if they did not.
- **`updated_at` is missing on invoices, estimates and vouchers**, so changes to those cannot be
  detected at all — see the trigger table above.
- `page_size` is silently clamped to 100.
- **`vat_rate` on a position is a name, not a number** — the tax rate as the account has it
  configured, for example `"19%"` or `"0% Ohne USt (Kleinunternehmer)"`, and `"Keine Vorsteuer"` on
  vouchers. Nothing lists the valid names; read one off an existing record. `19` answers 422.
- `document_date` is required for an invoice even though the specification marks it optional.
- Filters are per endpoint and limited — mostly company, project and a date range. There is no
  full-text search.

## Development

```bash
npm install
npm run generate   # rebuild the property descriptions from the OpenAPI document
npm run lint
npm run build
npm run dev        # n8n with this node linked in
```

`nodes/Papierkram/descriptions/*.ts` is **generated** from `openapi/papierkram-v1.json` by
`tools/generate-descriptions.mjs`. Do not edit those files: change the generator or refresh the
spec and run `npm run generate`.

Refreshing the spec, once the account's own Swagger page is open at
`https://<account>.papierkram.de/api/v1/api-docs/index.html`:

```bash
curl -s https://demo.papierkram.de/api/v1/api-docs/api/v1/swagger.json -o openapi/papierkram-v1.json
npm run generate
```

The diff on the generated files is then the changelog of the API.

## Licence

[MIT](LICENSE) — everycore
