#!/usr/bin/env node
import { encryptSmsAuthToken } from '@documenso/lib/server-only/sms/sms-credentials';
import { ZSmsSettingsSchema } from '@documenso/lib/types/sms-settings';

/**
 * Prints the SQL that configures SMS for one team.
 *
 * The auth token has to be encrypted with the application's own key before it
 * is stored, so there is no way to write this row by hand. Until the settings
 * UI exists, this is the supported path.
 *
 * The token is read from stdin rather than an argument, so it never lands in
 * shell history or a process listing.
 */
type Options = {
  teamUrl: string;
  accountSid: string;
  senderNumber: string;
  brandLabel: string;
  defaultOn: boolean;
};

const USAGE = `Usage:
  echo "<auth-token>" | npx tsx scripts/configure-team-sms.ts \\
    --team-url=evertrade \\
    --account-sid=ACxxxxxxxx \\
    --sender-number=+18327775620 \\
    --brand-label=EverTrade \\
    [--default-on=true]

Requires NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY to be set to the same value the
application uses, so run this where that key is available.

Prints SQL to stdout. Review it, then run it against the Documenso database.`;

const parseArgs = (argv: string[]): Options => {
  const values = new Map<string, string>();

  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);

    if (match) {
      values.set(match[1], match[2]);
    }
  }

  const required = ['team-url', 'account-sid', 'sender-number', 'brand-label'];
  const missing = required.filter((key) => !values.get(key));

  if (missing.length > 0) {
    console.error(`Missing required argument(s): ${missing.map((key) => `--${key}`).join(', ')}\n`);
    console.error(USAGE);
    process.exit(1);
  }

  return {
    teamUrl: values.get('team-url') ?? '',
    accountSid: values.get('account-sid') ?? '',
    senderNumber: values.get('sender-number') ?? '',
    brandLabel: values.get('brand-label') ?? '',
    defaultOn: (values.get('default-on') ?? 'true') !== 'false',
  };
};

const readAuthTokenFromStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf-8').trim();
};

const escapeSqlLiteral = (value: string): string => value.replace(/'/g, "''");

const main = async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  if (!process.env.NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY) {
    console.error('NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY is not set.');
    console.error('Run this where the application key is available, or the token');
    console.error('will be encrypted with the wrong key and every send will fail.\n');
    console.error(USAGE);
    process.exit(1);
  }

  const options = parseArgs(process.argv.slice(2));

  if (process.stdin.isTTY) {
    console.error('Paste the Twilio auth token, then press Ctrl+D (Ctrl+Z on Windows):');
  }

  const authToken = await readAuthTokenFromStdin();

  if (!authToken) {
    console.error('No auth token was supplied on stdin.\n');
    console.error(USAGE);
    process.exit(1);
  }

  // Validate before encrypting, so a bad number or brand label fails here
  // rather than silently resolving to "disabled" at send time.
  const parsed = ZSmsSettingsSchema.safeParse({
    enabled: true,
    senderNumber: options.senderNumber,
    defaultOn: options.defaultOn,
    brandLabel: options.brandLabel,
    accountSid: options.accountSid,
    authToken: encryptSmsAuthToken(authToken),
  });

  if (!parsed.success) {
    console.error('These settings would be stored as invalid and would never send:\n');

    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }

    console.error('\nSender numbers must be E.164, for example +18327775620.');
    process.exit(1);
  }

  const settings = parsed.data;

  const json = escapeSqlLiteral(JSON.stringify(settings));
  const teamUrl = escapeSqlLiteral(options.teamUrl);

  console.log(`-- SMS settings for team '${options.teamUrl}'`);
  console.log(`-- Sender ${settings.senderNumber} on account ${settings.accountSid}`);
  console.log('-- The auth token below is encrypted; the plaintext is not stored anywhere.');
  console.log('');
  console.log('UPDATE "TeamGlobalSettings"');
  console.log(`SET "smsSettings" = '${json}'::jsonb`);
  console.log(`WHERE id = (SELECT "teamGlobalSettingsId" FROM "Team" WHERE url = '${teamUrl}');`);
  console.log('');
  console.log("-- Confirm exactly one row was updated, then point this number's");
  console.log('-- incoming-message webhook at:');
  console.log(`--   <app-url>/api/twilio/inbound-webhook/<teamId>   (SELECT id FROM "Team" WHERE url = '${teamUrl}';)`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
