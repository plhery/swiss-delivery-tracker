import contract from '../../../contracts/openapi.json';
import { apiRoute, json } from '../../../src/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute(
  async () => json(contract),
  { authenticated: false, loadService: false },
);
