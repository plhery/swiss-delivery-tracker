import {
  apiRoute,
  HttpError,
  json,
  parseUuid,
  requireService,
  requireUser,
  requireUserClient,
  type RouteParameters,
} from '../../../../../src/server/api';
import { wakeSyncWorker } from '../../../../../src/server/background';

interface PackageParameters extends RouteParameters {
  id: string;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute<PackageParameters>(async (context) => {
  const { id } = await context.route.params;
  const packageId = parseUuid(id, 'package id');
  const parcel = await requireUserClient(context).getPackage(packageId);
  if (!parcel) throw new HttpError(404, 'Package not found');
  const service = requireService(context);
  const job = await service.enqueueSyncJob({ userId: requireUser(context).id, packageId });
  wakeSyncWorker();
  return json({
    queued: job.queued,
    pending: await service.pendingSyncJobCount(requireUser(context).id),
    jobIds: typeof job.row.id === 'string' ? [job.row.id] : [],
  }, 202);
}, { serviceRequired: true });
