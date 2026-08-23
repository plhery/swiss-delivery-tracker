import {
  apiRoute,
  HttpError,
  json,
  readJsonObject,
  requireService,
  requireUser,
  requireUserClient,
} from '../../../src/server/api';
import { SupabaseError } from '../../../src/server/supabase';
import { wakeSyncWorker } from '../../../src/server/background';
import { newPackageValues } from '../../../src/server/validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute(async (context) => {
  const includeArchived = new URL(context.request.url).searchParams.get('includeArchived') === 'true';
  return json({
    packages: await requireUserClient(context).listPackages(includeArchived),
  });
}, { serviceRequired: true });

export const POST = apiRoute(async (context) => {
  const values = newPackageValues(await readJsonObject(context.request));
  const client = requireUserClient(context);
  const service = requireService(context);
  let parcel;
  try {
    parcel = await client.createPackage(
      values.trackingNumber,
      values.label,
      values.carrier,
      values.trackingUrl,
      values.dpdPostcode,
    );
  } catch (error) {
    if (error instanceof SupabaseError && error.code === 'P0001') {
      throw new HttpError(409, 'Your delivery box has reached its parcel limit', undefined, {
        cause: error,
      });
    }
    if (error instanceof SupabaseError && error.status === 409) {
      throw new HttpError(409, 'This tracking number is already in your delivery box', undefined, {
        cause: error,
      });
    }
    throw error;
  }

  const jobIds: string[] = [];
  try {
    const job = await service.enqueueSyncJob({
      userId: requireUser(context).id,
      packageId: String(parcel.id),
    });
    wakeSyncWorker();
    if (typeof job.row.id === 'string') jobIds.push(job.row.id);
  } catch (error) {
    if (!(error instanceof SupabaseError)) throw error;
    await service.updatePackage(String(parcel.id), {
      sync_status: 'error',
      sync_error: 'The first tracking check could not be queued. Try again shortly.',
    });
  }
  return json({ package: parcel, jobIds }, 201);
}, { serviceRequired: true });
