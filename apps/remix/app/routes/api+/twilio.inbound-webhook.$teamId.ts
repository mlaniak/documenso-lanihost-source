import { handleTwilioInboundWebhook } from '@documenso/lib/server-only/sms/handle-twilio-inbound-webhook';

import type { Route } from './+types/twilio.inbound-webhook.$teamId';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const teamId = Number(params.teamId);

  if (!Number.isInteger(teamId)) {
    return new Response('Invalid team', { status: 400 });
  }

  return await handleTwilioInboundWebhook(request, teamId);
};
