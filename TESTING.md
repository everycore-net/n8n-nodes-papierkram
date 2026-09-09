# Verifying against a live account

The package builds and passes the n8n lint, and every field name in it comes out of the OpenAPI
document rather than out of somebody's memory. What that does *not* prove is how the API behaves.

Part of this list has been checked against a live account (everycore, package M) on **9 September
2026**, directly over HTTP rather than through n8n. Those results are recorded below. What is still
open is either a write, or something only n8n itself can exercise — the routing expressions, the
binary handling and the trigger's static data live in the runtime, not in the API.

Use a demo or test account for the write steps.

```bash
npm test        # the trigger's logic, no network
npm run dev     # starts n8n with the node linked in
```

`npm test` covers what does not need an account: the watermark, the paging decisions and the request
count per poll. Everything below needs a real system, which is why it is a checklist and not a test
suite.

## Confirmed against the API — 9 September 2026

- **Auth.** `GET /info` with a token from Einstellungen → API answers 200. A token from another
  account answers 401 `"Der Access Token ist nicht gültig/korrekt"`, and a subdomain without a
  Papierkram account answers the marketing site as HTML instead of JSON — worth recognising, because
  the second case does not look like an error at all.
- **Envelope.** List responses carry `type,page,page_size,total_pages,total_entries,has_more,entries`
  — the names the node's pagination and `rootProperty` depend on.
- **Paging.** 20 companies at `page_size=5` come back as four requests with `has_more` false on the
  last. `page_size=250` is silently clamped to 100, so the node's Limit maximum of 100 is the real
  ceiling.
- **Cost.** One list request costs one credit; the account showed 9,641 of 10,000 credits left.
- **Filters.** `document_date_range_start=2030-01-01` and `document_date_range_end=2020-01-01` both
  narrow to 0 records, so date filters reach the query string and are applied.
- **Sort order** — what the trigger stands on. `order_by=id&order_direction=desc` really does sort
  descending, and so does `order_by=updated_at`. An unknown field answers **HTTP 500**, not a
  validation error; the node's Order By description says so.
- **`updated_at`.** Present on bank transactions, companies, projects, propositions, tasks and time
  entries; **absent** on invoices, estimates and vouchers. Format is ISO 8601 with offset
  (`2026-09-08T10:55:17.000+02:00`). This is what the trigger's two modes are built on.
- **PDF.** `GET /income/invoices/{id}/pdf` answers `application/pdf`, ~50 kB, magic `%PDF`.

## Still open

### 1. The node inside n8n — done on 9 September 2026

Checked in n8n **2.35.5** with `tools/live-n8n-check.mjs`, which builds a throwaway credential and a
webhook workflow, drives them, and deletes both again:

- [x] Both nodes register as `@everyc0re/n8n-nodes-papierkram.papierkram` and `.papierkramTrigger`,
      and n8n derives a third one — *Papierkram Tool* — from `usableAsTool`.
- [x] *Trigger On* is offered for the six resources that carry `updated_at` and for none of the
      three that do not — read off the node description n8n actually serves, not off the source.
- [x] *Invoice → Get Many*, limit 5 → five items, one invoice per item, no envelope around them.
- [x] Return All → all 20 companies, so the `has_more` pagination expression works.
- [x] *Invoice → PDF* → `application/pdf`, 63 kB, magic `%PDF`.
- [x] *Invoice → Create* **through the node**: the nested `Customer ID` arrives as `customer.id`,
      the positions arrive as a JSON array, `document_date` is set — read back over the API, because
      the node's own answer would only prove that something was accepted.
- [x] Voucher document upload **through the node**: create voucher → invoice PDF → upload → read
      back reports one attached document. This is the multipart path over n8n's own HTTP layer,
      which the API-level check could not cover.
- [x] Credential test: green — after a fix. It answered *Not Acceptable* first, because Papierkram
      returns **406 without an `Accept` header** and `ICredentialTestRequest` sends none by itself.
      The node was never affected, so nothing but a real credential dialog would have caught it.

Three n8n 2.x details worth writing down, all of them found the hard way: a workflow activates
through `POST /rest/workflows/:id/activate` and needs the `versionId` it last handed out (a plain
`PATCH {active:true}` answers 200 and leaves it off), deletion requires archiving first, and a
webhook in `lastNode` mode returns only the first item unless `responseData` says otherwise — which
makes any item count meaningless and hands back a PDF as JSON.

### 2. Trigger — done on 9 September 2026

`tools/live-trigger-check.mjs` activates a one-minute poll on companies, waits out the first poll,
creates a company, waits for the next one and deletes everything again. It runs for about three
minutes, because that is how long the thing under test takes.

- [x] The first poll adopts the account's state and produces **no execution** — activating a
      workflow does not replay the account into it.
- [x] The company created afterwards produced exactly **one** execution, status success, carrying
      that company's ID and name.
- [x] **One** record in the payload, not the other 20: the watermark holds.

- [x] A manual execution, run through the same route the editor uses, delivered ten records — the
      preview cap — and left the workflow's static data `null`. A look does not consume records.

One thing is still only reasoned about rather than observed:

- [ ] *Trigger On: New and Updated Records*: editing an existing company and seeing the poll pick
      the edit up. The mechanism is the same watermark the unit tests cover, with `updated_at`
      instead of `id`, and the sort order it needs was measured against the account — but the full
      round trip has not been run.

### 3. The writing endpoints

Two things the OpenAPI document cannot answer: whether `customer: { id }` is really how a customer
is attached to an invoice, and whether the document endpoint accepts a multipart body built the way
`nodes/Papierkram/GenericFunctions.ts` builds it — no `Content-Type` of its own, boundary from the
runtime. It is the only endpoint in the package that does not take JSON, so if anything breaks
there, that helper is the only place to look.

`tools/live-write-check.mjs` exercises both and deletes what it created in a `finally` block. It
writes to whichever account the token belongs to; a draft invoice has no number yet, so removing it
leaves no gap in the numbering, but a test account is still the better target.

```bash
PAPIERKRAM_ACCOUNT=meinefirma PAPIERKRAM_TOKEN=<token> node tools/live-write-check.mjs
```

Run on 9 September 2026, all three green:

- [x] Invoice: created as a draft without a number, `billing.company` filled — `customer.id` is the
      right nesting — and the line item arrived.
- [x] Voucher document: upload answers **201** with `{type,id,uri}`, so the multipart body the node
      builds is the one the server wants.
- [x] Cleanup: both delete with 204 and read back as 404.

Two things cost a 422 before that and are now field hints in the node:

- `document_date` is **required in practice** for an invoice — without it the API answers
  *"Datum muss ausgefüllt werden"* — although the specification lists only name, payment_term and
  line_items as required.
- `vat_rate` is **not a percentage**. It is the name of a tax rate as the account has it configured:
  `"0% Ohne USt (Kleinunternehmer)"` on a Kleinunternehmer account, `"Keine Vorsteuer"` on the
  voucher side. Sending `19` answers *"Steuer muss ausgewählt werden"*. No endpoint lists the valid
  names, so the check reads one off an existing record — which is what a workflow has to do too.

Passing the script is necessary but not sufficient for the node — it proves the API accepts the
shapes, while the node still has to produce them through the declarative routing. Section 1 is where
that gets settled.
