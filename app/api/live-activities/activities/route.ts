import {
  apiRoute,
  HttpError,
  json,
  readJsonObject,
  requireService,
  requireUser,
  requireUserClient,
} from '../../../../src/server/api';
import { pushServices } from '../../../../src/server/push';
import {
  deleteLiveActivityUpdateToken,
  liveActivityUpdateToken,
} from '../../../../src/server/validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute(async (context) => {
  const service = requireService(context);
  if (!pushServices(service).liveActivities) {
    throw new HttpError(503, 'Live Activity push notifications are not configured');
  }
  const values = liveActivityUpdateToken(await readJsonObject(context.request));
  if (!await requireUserClient(context).getPackage(values.parcelId)) {
    throw new HttpError(404, 'Package not found');
  }
  const device = await service.getLiveActivityDevice(
    requireUser(context).id,
    values.installationId,
  );
  if (typeof device?.id !== 'string') {
    throw new HttpError(409, 'Register this iPhone for Live Activities first');
  }
  if (device.environment !== values.environment) {
    throw new HttpError(409, 'Live Activity APNs environments do not match');
  }
  await service.upsertLiveActivityUpdateToken({
    deviceId: device.id,
    packageId: values.parcelId,
    activityId: values.activityId,
    token: values.token,
    environment: values.environment,
    locale: values.locale,
  });
  return json({ ok: true }, 201);
}, { serviceRequired: true });

export const DELETE = apiRoute(async (context) => {
  const values = deleteLiveActivityUpdateToken(await readJsonObject(context.request));
  await requireService(context).deleteLiveActivityUpdateToken(
    requireUser(context).id,
    values.installationId,
    values.activityId,
  );
  return json({ ok: true });
}, { serviceRequired: true });
