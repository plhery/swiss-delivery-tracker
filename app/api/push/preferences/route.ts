import {
  apiRoute,
  json,
  readJsonObject,
  requireUserClient,
} from '../../../../src/server/api';
import {
  notificationPreferences,
  notificationPreferencesResponse,
} from '../../../../src/server/validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute(async (context) => json(
  notificationPreferencesResponse(await requireUserClient(context).getNotificationPreferences()),
), { serviceRequired: true });

export const PATCH = apiRoute(async (context) => {
  const values = notificationPreferences(await readJsonObject(context.request));
  const row = await requireUserClient(context).setNotificationPreferences(
    values.enabledStages,
    values.quietHoursStart,
    values.quietHoursEnd,
    values.timezone,
  );
  return json(notificationPreferencesResponse(row));
}, { serviceRequired: true });
