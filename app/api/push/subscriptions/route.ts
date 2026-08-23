import {
  apiRoute,
  HttpError,
  json,
  readJsonObject,
  requireService,
  requireUser,
} from '../../../../src/server/api';
import { pushServices } from '../../../../src/server/push';
import { pushEndpoint, pushSubscription } from '../../../../src/server/validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute(async (context) => {
  const service = requireService(context);
  const notifier = pushServices(service).web;
  if (!notifier) throw new HttpError(503, 'Push notifications are not configured');
  const values = pushSubscription(await readJsonObject(context.request));
  const subscription = await service.upsertPushSubscription(
    requireUser(context).id,
    values.endpoint,
    values.p256dh,
    values.auth,
    context.request.headers.get('user-agent')?.slice(0, 300) || null,
  );
  let testSent = true;
  try {
    await notifier.sendTest(subscription);
  } catch {
    testSent = false;
  }
  return json({ ok: true, testSent }, 201);
}, { serviceRequired: true });

export const DELETE = apiRoute(async (context) => {
  const service = requireService(context);
  const endpoint = pushEndpoint((await readJsonObject(context.request)).endpoint);
  await service.deletePushSubscription(requireUser(context).id, endpoint);
  return json({ ok: true });
}, { serviceRequired: true });
