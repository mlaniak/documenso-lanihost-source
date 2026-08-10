import { handleTwilioStatusWebhook } from '@documenso/lib/server-only/sms/handle-twilio-status-webhook';

import type { Route } from './+types/twilio.status-webhook.$teamId';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const teamId = Number(params.teamId);

  if (!Number.isInteger(teamId)) {
    return new Response('Invalid team', { status: 400 });
  }

  return await handleTwilioStatusWebhook(request, teamId);
};
