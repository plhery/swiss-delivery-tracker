import {
  apiRoute,
  HttpError,
  json,
  parseUuid,
  requireService,
  requireUser,
  type RouteParameters,
} from '../../../../../src/server/api';
import { syncJobResponse } from '../../../../../src/server/validation';

interface JobParameters extends RouteParameters {
  id: string;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute<JobParameters>(async (context) => {
  const { id } = await context.route.params;
  const jobId = parseUuid(id, 'sync job id');
  const job = await requireService(context).getSyncJob(jobId, requireUser(context).id);
  if (!job) throw new HttpError(404, 'Sync job not found');
  return json(syncJobResponse(job));
}, { serviceRequired: true });
