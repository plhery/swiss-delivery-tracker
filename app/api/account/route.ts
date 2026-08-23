import { authenticator, SupabaseAuthError } from '../../../src/server/auth';
import {
  apiRoute,
  HttpError,
  json,
  readJsonObject,
  requireService,
  requireUser,
} from '../../../src/server/api';

const RECENT_AUTH_MAX_AGE_MS = 10 * 60 * 1_000;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = apiRoute(async (context) => {
  const payload = await readJsonObject(context.request);
  const confirmation = payload.confirmation;
  const user = requireUser(context);
  if (
    typeof confirmation !== 'string'
    || !user.email
    || confirmation.trim().toLocaleLowerCase('en-US') !== user.email.toLocaleLowerCase('en-US')
  ) throw new HttpError(400, 'Type your account email exactly to confirm deletion');
  if (!context.token) {
    throw new HttpError(401, 'Sign in again before permanently deleting your account');
  }
  const auth = authenticator();
  if (!auth) throw new HttpError(401, 'Sign in again before permanently deleting your account');
  let freshUser;
  try {
    freshUser = await auth.validate(context.token, false);
  } catch (error) {
    if (error instanceof SupabaseAuthError) {
      throw new HttpError(401, 'Sign in again before permanently deleting your account', undefined, {
        cause: error,
      });
    }
    throw error;
  }
  if (freshUser.id !== user.id || !freshUser.sessionId || !freshUser.authenticatedAt) {
    throw new HttpError(401, 'Sign in again before permanently deleting your account');
  }
  const age = Date.now() - freshUser.authenticatedAt.getTime();
  if (age < -60_000 || age > RECENT_AUTH_MAX_AGE_MS) {
    throw new HttpError(401, 'Sign in again before permanently deleting your account');
  }
  await requireService(context).deleteAuthUser(freshUser.id);
  return json({ ok: true });
}, { serviceRequired: true });
