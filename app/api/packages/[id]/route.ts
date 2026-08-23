import {
  apiRoute,
  HttpError,
  json,
  parseUuid,
  readJsonObject,
  requireUserClient,
  type RouteParameters,
} from '../../../../src/server/api';
import { packageLabel } from '../../../../src/server/validation';

interface PackageParameters extends RouteParameters {
  id: string;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = apiRoute<PackageParameters>(async (context) => {
  const { id } = await context.route.params;
  const packageId = parseUuid(id, 'package id');
  const label = packageLabel(await readJsonObject(context.request));
  const client = requireUserClient(context);
  await client.updatePackage(packageId, { label });
  const parcel = await client.getPackage(packageId);
  if (!parcel) throw new HttpError(404, 'Package not found');
  return json(parcel);
}, { serviceRequired: true });

export const DELETE = apiRoute<PackageParameters>(async (context) => {
  const { id } = await context.route.params;
  const packageId = parseUuid(id, 'package id');
  const client = requireUserClient(context);
  if (!await client.getPackage(packageId)) throw new HttpError(404, 'Package not found');
  await client.archivePackage(packageId);
  return json({ ok: true });
}, { serviceRequired: true });
