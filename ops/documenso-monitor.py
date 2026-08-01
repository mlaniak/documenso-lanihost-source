#!/usr/bin/env python3
"""Stateful production monitor for the self-hosted Documenso service."""

from __future__ import annotations

import json
import os
import smtplib
import ssl
import subprocess
import sys
import time
from email.message import EmailMessage
from pathlib import Path

MONITOR_CONFIG_FILE = Path(
    os.environ.get("DOCUMENSO_MONITOR_CONFIG_FILE", "/opt/documenso/monitor.env")
)


def read_key_value_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}

    if not path.exists():
        return values

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key.strip()] = value

    return values


for config_key, config_value in read_key_value_file(MONITOR_CONFIG_FILE).items():
    os.environ.setdefault(config_key, config_value)


APP_URL = os.environ.get("DOCUMENSO_MONITOR_APP_URL", "http://localhost:3000").rstrip("/")
ENV_FILE = Path(os.environ.get("DOCUMENSO_APP_ENV_FILE", "/opt/documenso/.env"))
STATE_FILE = Path(
    os.environ.get("DOCUMENSO_MONITOR_STATE_FILE", "/var/lib/documenso-monitor/state.json")
)
BACKUP_DIRECTORY = Path(
    os.environ.get("DOCUMENSO_BACKUP_DIRECTORY", "/opt/backups/databases")
)
ALERT_TO = os.environ.get("DOCUMENSO_MONITOR_ALERT_TO", "")
BACKUP_S3_BUCKET = os.environ.get("DOCUMENSO_BACKUP_S3_BUCKET", "")
BACKUP_S3_PREFIX = os.environ.get("DOCUMENSO_BACKUP_S3_PREFIX", "databases").strip("/")
BACKUP_S3_PROFILE = os.environ.get("DOCUMENSO_BACKUP_S3_PROFILE", "backup")
BACKUP_S3_REGION = os.environ.get("DOCUMENSO_BACKUP_S3_REGION", "us-east-2")
ERROR_PATTERNS = (
    "configured email transport could not be resolved",
    "failed to decrypt",
    "failed to send email",
    "error sending email",
    "smtp error",
    "econnrefused",
    "rate limit exceeded",
)


def read_env() -> dict[str, str]:
    return read_key_value_file(ENV_FILE)


def run(*args: str) -> tuple[int, str, str]:
    result = subprocess.run(args, check=False, capture_output=True, text=True)
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def query_database(statement: str) -> str | None:
    code, output, _ = run(
        "docker",
        "exec",
        "documenso-db",
        "psql",
        "-U",
        "documenso",
        "-d",
        "documenso",
        "-Atc",
        statement,
    )
    return output if code == 0 else None


def check_http(path: str) -> str | None:
    code, status, _ = run(
        "curl",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "20",
        "-A",
        "LaniHQ-Documenso-Monitor/2.0",
        f"{APP_URL}{path}",
    )
    if code != 0 or not status.startswith(("2", "3")):
        return status or "unreachable"
    return None


def check_backup() -> list[str]:
    findings: list[str] = []
    backups = sorted(BACKUP_DIRECTORY.glob("documenso_*.sql.gz.gpg"), key=lambda item: item.stat().st_mtime)

    if not backups:
        return ["no encrypted Documenso database backup was found"]

    latest = backups[-1]
    age_hours = (time.time() - latest.stat().st_mtime) / 3600
    if age_hours > 30:
        findings.append(f"latest encrypted database backup is {age_hours:.1f} hours old")
    if latest.stat().st_size < 1024:
        findings.append("latest encrypted database backup is unexpectedly small")

    checksum_path = latest.with_suffix(latest.suffix + ".sha256")
    if not checksum_path.exists():
        findings.append("latest encrypted database backup has no checksum sidecar")
    else:
        code, _, _ = run("sha256sum", "--check", str(checksum_path))
        if code != 0:
            findings.append("latest encrypted database backup checksum validation failed")

    if not BACKUP_S3_BUCKET:
        findings.append("off-site backup bucket is not configured")
        return findings

    object_key = "/".join(part for part in (BACKUP_S3_PREFIX, latest.name) if part)
    aws_args = [
        "/snap/bin/aws",
        "s3",
        "ls",
        f"s3://{BACKUP_S3_BUCKET}/{object_key}",
        "--region",
        BACKUP_S3_REGION,
    ]
    if BACKUP_S3_PROFILE:
        aws_args.extend(["--profile", BACKUP_S3_PROFILE])

    code, output, _ = run(*aws_args)
    if code != 0 or latest.name not in output:
        findings.append("latest encrypted database backup is missing from off-site S3 storage")

    return findings


def check() -> list[str]:
    findings: list[str] = []

    _, state, _ = run("docker", "inspect", "-f", "{{.State.Status}}", "documenso")
    if state != "running":
        findings.append(f"container state is {state or 'unknown'}")

    _, health, _ = run(
        "docker",
        "inspect",
        "-f",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
        "documenso",
    )
    if health != "healthy":
        findings.append(f"container health is {health or 'unknown'}")

    for path in ("/", "/api/health", "/api/certificate-status"):
        status = check_http(path)
        if status:
            findings.append(f"public {path} HTTP status is {status}")

    _, recent_logs, _ = run("docker", "logs", "--since", "6m", "documenso")
    matched = [pattern for pattern in ERROR_PATTERNS if pattern in recent_logs.lower()]
    if matched:
        findings.append("recent application/email errors: " + ", ".join(matched))

    overdue = query_database(
        'SELECT count(*) FROM "ScheduledReminderDelivery" '
        "WHERE status = 'PENDING' AND \"nextAttemptAt\" < NOW() - INTERVAL '30 minutes';"
    )
    if overdue is not None and int(overdue or "0") > 0:
        findings.append(f"{overdue} scheduled reminder deliveries are over 30 minutes late")

    stale = query_database(
        'SELECT count(*) FROM "ScheduledReminderDelivery" '
        "WHERE status = 'PROCESSING' AND \"claimedAt\" < NOW() - INTERVAL '30 minutes';"
    )
    if stale is not None and int(stale or "0") > 0:
        findings.append(f"{stale} scheduled reminder deliveries have stale worker claims")

    failed_deliveries = query_database(
        'SELECT count(*) FROM "ScheduledReminderDelivery" '
        "WHERE status = 'FAILED' AND \"failedAt\" > NOW() - INTERVAL '6 minutes';"
    )
    if failed_deliveries is not None and int(failed_deliveries or "0") > 0:
        findings.append(f"{failed_deliveries} scheduled reminder deliveries failed recently")

    failed_jobs = query_database(
        'SELECT count(*) FROM "BackgroundJob" '
        "WHERE status = 'FAILED' AND \"completedAt\" > NOW() - INTERVAL '6 minutes';"
    )
    if failed_jobs is not None and int(failed_jobs or "0") > 0:
        findings.append(f"{failed_jobs} background jobs failed recently")

    findings.extend(check_backup())
    return findings


def send_alert(subject: str, body: str) -> None:
    if not ALERT_TO:
        raise RuntimeError("DOCUMENSO_MONITOR_ALERT_TO is required for alert delivery")

    env = read_env()
    host = env["NEXT_PRIVATE_SMTP_HOST"]
    port = int(env.get("NEXT_PRIVATE_SMTP_PORT", "465"))
    username = env["NEXT_PRIVATE_SMTP_USERNAME"]
    password = env["NEXT_PRIVATE_SMTP_PASSWORD"]
    from_name = env.get("NEXT_PRIVATE_SMTP_FROM_NAME", "LaniHQ Documents")
    from_address = env["NEXT_PRIVATE_SMTP_FROM_ADDRESS"]

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"{from_name} <{from_address}>"
    message["To"] = ALERT_TO
    message["Reply-To"] = "support@lanihq.com"
    message.set_content(body)

    context = ssl.create_default_context()
    if port == 465:
        client: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=30, context=context)
    else:
        client = smtplib.SMTP(host, port, timeout=30)
        client.starttls(context=context)
    try:
        client.login(username, password)
        client.send_message(message)
    finally:
        client.quit()


def main() -> int:
    if "--self-test-alert" in sys.argv:
        send_alert(
            "Documenso monitoring test passed",
            "The Documenso production monitor can reach its configured alert channel.",
        )
        print("Self-test alert sent.")
        return 0

    findings = check()
    current = {"healthy": not findings, "findings": findings}

    previous: dict[str, object] = {}
    if STATE_FILE.exists():
        try:
            previous = json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            previous = {}

    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(current, indent=2) + "\n")

    if previous and previous != current:
        if current["healthy"]:
            send_alert("Documenso recovered", f"Documenso is healthy again.\n\nService: {APP_URL}")
        else:
            detail = "\n".join(f"- {item}" for item in findings)
            send_alert(
                "Documenso needs attention",
                f"The production monitor found:\n\n{detail}\n\nService: {APP_URL}",
            )

    print(json.dumps(current, separators=(",", ":")))
    return 0 if current["healthy"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
