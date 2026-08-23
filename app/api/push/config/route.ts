import { apiRoute, json } from '../../../../src/server/api';
import { pushServices } from '../../../../src/server/push';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute(async (context) => {
  const notifier = context.service ? pushServices(context.service).web : null;
  return json({
    available: notifier !== null,
    publicKey: notifier?.publicKey ?? null,
  });
});
