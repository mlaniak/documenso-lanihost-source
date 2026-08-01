# LaniHost scheduled reminder operations

The corresponding source for the deployed AGPL-3.0 build is published at
<https://github.com/mlaniak/documenso-lanihost-source>. Production documents,
database contents, secrets, backups, and environment files are not part of the
source repository.

This fork adds retry-safe one-off signing reminders to Documenso 2.15.0.

## Delivery model

Each selected recipient gets one durable `ScheduledReminderDelivery` record. Only one record may be active for a recipient. Workers atomically claim due rows, deliver one recipient at a time, and store every terminal outcome.

- `PENDING`: waiting for its scheduled time or a retry.
- `PROCESSING`: claimed by one worker.
- `SENT`: email delivery completed.
- `FAILED`: five attempts were exhausted.
- `CANCELLED`: cancelled by a user or made obsolete by document completion/cancellation.

Retries use 5-minute, 15-minute, 45-minute, 135-minute, and 6-hour backoff windows. Claims older than 15 minutes are recovered by the next sweep. The sweep runs every five minutes.

SMTP cannot provide strict exactly-once semantics. A process crash after the remote SMTP server accepts a message but before the database finalizes it can cause one duplicate on retry. The ledger is designed to prevent silent loss and duplicate concurrent claims.

## Audit and monitoring

The document audit log records schedule, delivery, cancellation, and terminal failure events. The document list shows active, sending, recently sent, and failed state with local-time details.

`ops/documenso-monitor.py` checks public endpoints, container health, recent email errors and rate limits, overdue or failed scheduled deliveries, failed background jobs, local encrypted backup freshness and checksum, and the corresponding off-site S3 object.

## Backup verification

`ops/checksum-documenso-backup.sh` writes the checksum sidecar after the nightly encrypted backup. `ops/verify-documenso-backup.sh` validates the checksum, decrypts and restores the latest backup into an isolated temporary database, compares core row counts, and removes the temporary database.

Recommended production schedule:

```cron
20 3 * * * /opt/documenso/checksum-documenso-backup.sh >> /var/log/documenso-backup-checksum.log 2>&1
45 4 1 * * /opt/documenso/verify-documenso-backup.sh >> /var/log/documenso-restore-drill.log 2>&1
```

## Release workflow

Keep `origin` pointed at the controlled LaniHost mirror and `upstream` pointed at `documenso/documenso`. Rebase the customization branch on a reviewed upstream tag, run the validation workflow, build an exact-commit image, retain the current image as a rollback tag, back up the database/configuration, apply migrations, deploy, and verify health plus authenticated UI state.

Copy `ops/documenso-monitor.env.example` to `/opt/documenso/monitor.env`, fill
the server-specific values, and set mode `600`. The public example contains no
production email address, bucket name, application data, or credentials.

The running modified source must either be made available under AGPL-3.0 to network users or covered by a Documenso commercial license. Do not enable Enterprise claim flags without a valid license.
