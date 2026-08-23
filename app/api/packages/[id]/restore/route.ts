import {
  apiRoute,
  HttpError,
  json,
  parseUuid,
  requireUserClient,
  type RouteParameters,
} from '../../../../../src/server/api';
import { SupabaseError } from '../../../../../src/server/supabase';

interface PackageParameters extends RouteParameters {
  id: string;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute<PackageParameters>(async (context) => {
  const { id } = await context.route.params;
  const packageId = parseUuid(id, 'package id');
  const client = requireUserClient(context);
  const original = await client.getPackage(packageId);
  if (!original) throw new HttpError(404, 'Package not found');
  try {
    await client.restorePackage(packageId);
  } catch (error) {
    if (error instanceof SupabaseError && error.code === 'P0001') {
      throw new HttpError(409, 'Your delivery box has reached its parcel limit', undefined, {
        cause: error,
      });
    }
    throw error;
  }
  return json(await client.getPackage(packageId) ?? { ...original, archived_at: null });
}, { serviceRequired: true });
