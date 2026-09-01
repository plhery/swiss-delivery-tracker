import {
  apiRoute,
  HttpError,
  json,
  parseUuid,
  readJsonObject,
  requireService,
  requireUser,
  requireUserClient,
  type RouteParameters,
} from '../../../../../src/server/api';
import { wakeSyncWorker } from '../../../../../src/server/background';
import { logOperationalEvent } from '../../../../../src/server/observability';
import { SupabaseError } from '../../../../../src/server/supabase';
import { packageCarrierValues } from '../../../../../src/server/validation';

interface PackageParameters extends RouteParameters {
  id: string;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export const PATCH = apiRoute<PackageParameters>(async (context) => {
  const { id } = await context.route.params;
  const packageId = parseUuid(id, 'package id');
  const client = requireUserClient(context);
  const service = requireService(context);
  const original = await client.getPackage(packageId);
  if (!original || typeof original.tracking_number !== 'string') {
    throw new HttpError(404, 'Package not found');
  }

  const values = packageCarrierValues(
    await readJsonObject(context.request),
    original.tracking_number,
  );
  const unchanged = original.carrier === values.carrier
    && nullableText(original.tracking_url) === values.trackingUrl
    && nullableText(original.dpd_postcode) === values.dpdPostcode;
  if (unchanged) return json({ package: original, jobIds: [] });

  if (!await client.changePackageCarrier(
    packageId,
    values.carrier,
    values.trackingUrl,
    values.dpdPostcode,
  )) throw new HttpError(404, 'Package not found');

  logOperationalEvent('package_carrier_changed', {
    package_id: packageId,
    previous_carrier: String(original.carrier ?? 'unknown'),
    carrier: values.carrier,
    archived: original.archived_at != null,
  });

  const jobIds: string[] = [];
  if (original.archived_at == null) {
    try {
      const job = await service.enqueueSyncJob({
        userId: requireUser(context).id,
        packageId,
      });
      wakeSyncWorker();
      if (typeof job.row.id === 'string') jobIds.push(job.row.id);
    } catch (error) {
      if (!(error instanceof SupabaseError)) throw error;
      await service.updatePackage(packageId, {
        sync_status: 'error',
        sync_error: 'The tracking check for the new carrier could not be queued. Try again shortly.',
      });
    }
  }

  const parcel = await client.getPackage(packageId);
  if (!parcel) throw new HttpError(404, 'Package not found');
  return json({ package: parcel, jobIds });
}, { serviceRequired: true });
