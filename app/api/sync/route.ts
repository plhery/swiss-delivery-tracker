import {
  apiRoute,
  json,
  requireService,
  requireUser,
  requireUserClient,
} from '../../../src/server/api';
import { wakeSyncWorker } from '../../../src/server/background';

const MAX_USER_SYNC_JOBS = 5;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute(async (context) => {
  const service = requireService(context);
  const userId = requireUser(context).id;
  const jobIds: string[] = [];
  let queued = false;
  for (const parcel of (await requireUserClient(context).listActivePackages()).slice(0, MAX_USER_SYNC_JOBS)) {
    if (typeof parcel.id !== 'string') continue;
    const job = await service.enqueueSyncJob({ userId, packageId: parcel.id });
    queued ||= job.queued;
    if (typeof job.row.id === 'string' && !jobIds.includes(job.row.id)) jobIds.push(job.row.id);
  }
  if (jobIds.length > 0) wakeSyncWorker();
  return json({
    queued,
    pending: await service.pendingSyncJobCount(userId),
    jobIds,
  }, 202);
}, { serviceRequired: true });
