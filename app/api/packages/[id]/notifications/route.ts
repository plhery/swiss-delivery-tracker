import {
  apiRoute,
  HttpError,
  json,
  parseUuid,
  readJsonObject,
  requireUserClient,
  type RouteParameters,
} from '../../../../../src/server/api';
import { SupabaseError } from '../../../../../src/server/supabase';

interface PackageParameters extends RouteParameters {
  id: string;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = apiRoute<PackageParameters>(async (context) => {
  const { id } = await context.route.params;
  const packageId = parseUuid(id, 'package id');
  const payload = await readJsonObject(context.request);
  if (typeof payload.muted !== 'boolean') throw new HttpError(400, 'Muted must be true or false');
  const client = requireUserClient(context);
  try {
    await client.updatePackage(packageId, { notifications_muted: payload.muted });
  } catch (error) {
    if (error instanceof SupabaseError && error.status === 404) {
      throw new HttpError(404, 'Package not found', undefined, { cause: error });
    }
    throw error;
  }
  const parcel = await client.getPackage(packageId);
  if (!parcel) throw new HttpError(404, 'Package not found');
  return json(parcel);
}, { serviceRequired: true });
