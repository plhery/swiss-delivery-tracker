import {
  apiRoute,
  HttpError,
  json,
  parseUuid,
  requireUserClient,
  type RouteParameters,
} from '../../../../../src/server/api';

interface PackageParameters extends RouteParameters {
  id: string;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = apiRoute<PackageParameters>(async (context) => {
  const { id } = await context.route.params;
  const packageId = parseUuid(id, 'package id');
  const client = requireUserClient(context);
  if (!await client.getPackage(packageId) || !await client.deletePackage(packageId)) {
    throw new HttpError(404, 'Package not found');
  }
  return json({ ok: true });
}, { serviceRequired: true });
