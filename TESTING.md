# Verifying against a live account

The package builds and passes the n8n lint, and every field name in it comes out of the OpenAPI
document rather than out of somebody's memory. What that does *not* prove is how the API behaves,
and a few things in here rest on assumptions that only an account can settle. This is the list, in
the order that matters.

Use a demo or test account: several of these steps write.

```bash
npm run dev     # starts n8n with the node linked in
```

## 1. Credentials

Create a **Papierkram API** credential and hit *Test*. It calls `GET /info`.

- Fails with 401 → account name or token wrong.
- Fails with 404 → check the account name; the token is only valid on its own subdomain.

## 2. Get Many, paging and the limit

*Invoice → Get Many*, **Return All** off, limit 5.

- [ ] Five items arrive, one invoice per item, no `entries`/`total_pages` wrapper.
- [ ] The request sent `page_size=5` (one page, five records — not a full page trimmed afterwards).

Then **Return All** on, in an account with more than 100 invoices.

- [ ] Everything arrives. The pagination continues on `has_more` and raises `page`; if it stops at
      100, the envelope does not carry `has_more` the way the spec's example shows.

## 3. Filters

*Invoice → Get Many* with a **Document Date Range Start**.

- [ ] The filter reaches the query string and narrows the result.
- [ ] Date format: the spec types these as plain strings. Try `2026-01-01` first.

## 4. Sort order — the one the trigger depends on

*Invoice → Get Many*, **Options → Order By** `id`, **Order Direction** `desc`.

- [ ] Records come back newest first.

If they do not, `order_by` is either not supported for this endpoint or wants a different field
name. The trigger detects that and falls back to walking every page, which costs credits; if the
fallback is what actually happens, `ENDPOINTS`/the sort field in `PapierkramTrigger.node.ts` needs
the field name that does work.

## 5. Trigger

Point *Papierkram Trigger* at **Invoice**.

- [ ] Manual execution shows the newest invoices and does **not** move the watermark.
- [ ] Activate, create an invoice in Papierkram, wait for the poll → exactly the new invoice
      arrives, once.
- [ ] Deactivate and reactivate → no replay of old invoices.
- [ ] Editing an existing invoice does *not* fire it. That is by design, not a bug: Papierkram
      offers nothing to detect changes with.

## 6. Create with nested fields

*Invoice → Create* with **Name**, **Payment Term ID** and **Line Items**:

```json
[{ "name": "Beratung", "quantity": 1, "unit": "Stunde", "price": 100, "vat_rate": 19 }]
```

- [ ] The invoice appears with the position.
- [ ] `Customer ID` from *Additional Fields* lands as `customer.id`, not as a flat `customer` — a
      wrong nesting shows up as a 422 with a German message, which the node passes through.

## 7. PDF

*Invoice → PDF* on an existing invoice.

- [ ] The output item has binary data in `data` and it opens as a PDF.

A file that opens as garbage means the response was decoded as text on the way; the request sets
`encoding: 'arraybuffer'` and `json: false` for exactly that reason, so check those first.

## 8. Voucher document upload — the least certain part

*Voucher Document → Create*, with an incoming item that carries a file in `data` (an HTTP Request
node reading a PDF is enough).

- [ ] The document is attached to the voucher.

This is the only endpoint that takes `multipart/form-data`. The node builds it in
`nodes/Papierkram/GenericFunctions.ts` with the runtime's `FormData`/`Blob` and removes the JSON
`Content-Type` so the boundary is generated. If the server answers 400 or 422 here, that helper is
where to look — nothing else in the package touches multipart.

## 9. Quota

- [ ] After a few calls, check `X-Remaining-Quota` in the response headers of an *n8n → HTTP
      Request* call, or Einstellungen → API in Papierkram, and get a feeling for what a poll
      interval costs. 10,000 credits a month is roughly one request every four minutes, and that is
      the whole budget for the account, not per workflow.
