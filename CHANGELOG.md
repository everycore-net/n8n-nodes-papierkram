# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-09-09

First release, published as `@everycore/n8n-nodes-papierkram`. Verified against n8n 2.35.5 and a
live Papierkram account (package M).

### Added

- **Papierkram** node covering the 59 endpoints of the Papierkram API v1: invoices, estimates,
  vouchers with their file attachments, companies and contact persons, projects, propositions,
  tasks, time entries, custom attributes, and the read-only banking, user, payment term and info
  lists. Declarative routing throughout — no transport code of its own.
- **Papierkram Trigger** node, polling, with two watermarks: new records by ID everywhere, and new
  *or changed* records by `updated_at` for the six resources that expose it. Invoices, estimates and
  vouchers do not carry the field, so the option is hidden for them rather than offered and broken.
- The node is `usableAsTool`, so n8n also registers it as **Papierkram Tool** for AI agents.
- Property descriptions are generated from the vendored OpenAPI document by
  `tools/generate-descriptions.mjs`. The API is in BETA; a version bump is then a diff on generated
  files rather than a hunt through the specification.
- Three importable example workflows in `examples/`.
- Unit tests for the trigger, and three scripts under `tools/` that exercise the package against a
  real API and a real n8n and clean up after themselves.

### Notes on the API these nodes talk to

Found by measurement, and the reason several fields carry unusual hints:

- Requests cost **credits** from a monthly budget (10,000 for package M), not merely rate limits.
  Every poll costs credits even when it finds nothing.
- `vat_rate` on a position is the **name** of a tax rate as configured in the account — `"19%"`,
  `"0% Ohne USt (Kleinunternehmer)"`, `"Keine Vorsteuer"` — and not a percentage. Nothing lists the
  valid names.
- `document_date` is required for an invoice although the specification marks it optional.
- An unknown `order_by` field answers HTTP 500 rather than a validation error.
- `page_size` is silently clamped to 100.
