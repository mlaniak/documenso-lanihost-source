# Public source notice

This repository provides the corresponding AGPL-3.0 source code for a modified
self-hosted Documenso deployment. The customization adds one-off scheduled
signing reminders, retry-safe per-recipient delivery records, audit history,
status feedback, and operational monitoring examples.

Production documents, recipient information, database contents, backups,
credentials, private keys, environment files, and server configuration are not
stored in this repository.

Server-specific monitoring values belong in `/opt/documenso/monitor.env`, using
`ops/documenso-monitor.env.example` as a template. The production file must
remain outside the repository and should be readable only by root.

This source remains licensed under AGPL-3.0. See `LICENSE` for the complete
license terms.
