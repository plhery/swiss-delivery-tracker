import {
  apiRoute,
  json,
  requireUser,
  requireUserClient,
} from '../../../../src/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute(async (context) => {
  const user = requireUser(context);
  return json({
    exportedAt: new Date().toISOString(),
    account: { id: user.id, email: user.email },
    packages: await requireUserClient(context).listPackages(true),
  }, 200, {
    'Content-Disposition': 'attachment; filename="swiss-delivery-tracker-export.json"',
  });
}, { serviceRequired: true });
