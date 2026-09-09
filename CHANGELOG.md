# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.1 — 2026-09-09

### Fixed

- Six actions had no label in the node's action list — Archive, Cancel, Pay, PDF and Unarchive
  showed an icon and nothing else, and Cancel With Reverse Entry showed a lone . A regular
  expression in the generator lost its backslashes during an edit, turning "strip a parenthetical
  aside" into "delete everything up to the first bracket".
- Operation names now split camel case, so the dropdown reads *Cancel With Reverse Entry* rather
  than *CancelWithReverseEntry*.
- The PDF action reads *Download an invoice as a PDF* instead of the specification's descriptive
  *Retrieves an invoice as a PDF* — every other row in that list is an instruction.

## 0.2.0 — 2026-09-09

### Changed

- **The package is now `n8n-nodes-papierkram`, without the `@everycore` scope.** The scope cost the
  nodes their icons: n8n builds the icon URL from the package name, and for a scoped package the
  result never resolves, so the editor draws a broken image where the icon belongs
  ([n8n#14408](https://github.com/n8n-io/n8n/issues/14408)). The files were served correctly the
  whole time — the URL simply did not reach them.
- Switching to a built-in `fa:` icon would have avoided the rename, but community nodes may not use
  one: `@n8n/community-nodes/icon-validation` requires the `file:` protocol. So the choice was the
  scope or the icon, and the icon is what every user sees.
- Node type IDs follow the package name, so a workflow built against `@everycore/…` needs its
  Papierkram nodes replaced. Nothing else changed: same nodes, same parameters, same credential.
- `@everycore/n8n-nodes-papierkram` is deprecated on npm and points here.

## 0.1.1 — 2026-09-09

### Changed

- The node interface is English throughout. Resource descriptions used German domain nouns —
  *Rechnungen*, *Angebote*, *Zeiterfassung* — which reads well to a German user and breaks n8n's
  verification guideline that interface and documentation must be English only. The example
  workflows and their notes are translated for the same reason.
- What stays German is what the API stores or answers, quoted as a value and glossed in English:
  tax rate names like `0% Ohne USt (Kleinunternehmer)`, the category `Bürobedarf`, the error
  *"Datum muss ausgefüllt werden"*. Those are not interface language; they are strings a workflow
  has to match exactly.

## 0.1.0 — 2026-09-09

First release, published as `n8n-nodes-papierkram`. Verified against n8n 2.35.5 and a
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
