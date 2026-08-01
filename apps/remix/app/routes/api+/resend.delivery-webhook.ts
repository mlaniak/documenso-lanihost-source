import { handleResendDeliveryWebhook } from '@documenso/lib/server-only/email/handle-resend-delivery-webhook';

import type { Route } from './+types/resend.delivery-webhook';

export const action = async ({ request }: Route.ActionArgs) => await handleResendDeliveryWebhook(request);
