import {
  apiRoute,
  HttpError,
  json,
  readJsonObject,
  requireService,
  requireUser,
} from '../../../../src/server/api';
import { pushServices } from '../../../../src/server/push';
import { nativePushDevice } from '../../../../src/server/validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute(async (context) => {
  const service = requireService(context);
  const notifier = pushServices(service).native;
  if (!notifier) throw new HttpError(503, 'Native push notifications are not configured');
  const values = nativePushDevice(await readJsonObject(context.request));
  const device = await service.upsertNativePushDevice(
    requireUser(context).id,
    values.token,
    values.environment,
    values.locale,
    values.installationId,
    values.deviceName,
  );
  let testSent = false;
  if (values.sendTest) {
    try {
      await notifier.sendTest(device);
      testSent = true;
    } catch {
      // Registration succeeds even when APNs is temporarily unavailable.
    }
  }
  return json({ ok: true, testSent }, 201);
}, { serviceRequired: true });

export const DELETE = apiRoute(async (context) => {
  const service = requireService(context);
  const values = nativePushDevice(await readJsonObject(context.request), false);
  await service.deleteNativePushDevice(requireUser(context).id, values.token);
  return json({ ok: true });
}, { serviceRequired: true });
