import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextRequest } from 'next/server';
import { authenticator, SupabaseAuthError, type SupabaseUser } from './auth';
import { RateLimiter } from './rateLimit';
import { serviceClient } from './runtime';
import {
  SupabaseError,
  type SupabaseServiceClient,
  type SupabaseUserClient,
} from './supabase';
import { errorMessage, isRecord, type JsonObject } from './types';

const MAX_JSON_BODY = 16_384;
const PREAUTH_REQUEST_LIMIT = 300;
const PREAUTH_REQUEST_WINDOW_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rateLimiter = new RateLimiter();

export interface RouteParameters {
  [key: string]: string | string[];
}

export interface RouteContext<Parameters extends RouteParameters = RouteParameters> {
  params: Promise<Parameters>;
}

export interface ApiContext<Parameters extends RouteParameters = RouteParameters> {
  request: NextRequest;
  route: RouteContext<Parameters>;
  requestId: string;
  user: SupabaseUser | null;
  token: string | null;
  userClient: SupabaseUserClient | null;
  service: SupabaseServiceClient | null;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: HeadersInit,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HttpError';
  }
}

interface ApiRouteOptions {
  authenticated?: boolean;
  serviceRequired?: boolean;
  loadService?: boolean;
}

type ApiHandler<Parameters extends RouteParameters> = (
  context: ApiContext<Parameters>,
) => Response | Promise<Response>;

function ratePolicy(method: string, pathname: string): {
  bucket: string;
  limit: number;
  window: number;
} {
  if (pathname === '/api/sync' || pathname.endsWith('/sync')) {
    return { bucket: 'sync', limit: 12, window: 300 };
  }
  if (method === 'GET' || method === 'HEAD') {
    return { bucket: 'read', limit: 240, window: 60 };
  }
  return { bucket: 'write', limit: 60, window: 60 };
}

function clientIp(request: NextRequest): string {
  if (process.env.TRUST_PROXY_HEADERS !== 'true') return 'untrusted';
  const candidate = request.headers.get('cf-connecting-ip')?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',', 1)[0]?.trim()
    || '';
  return isIP(candidate) ? candidate : 'unknown';
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

function apiResponse(
  status: number,
  payload: unknown,
  headers?: HeadersInit,
): Response {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

export function json(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return apiResponse(status, payload, headers);
}

export function noContent(status = 204, headers?: HeadersInit): Response {
  return new Response(null, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function failure(error: unknown): Response {
  if (error instanceof HttpError) {
    return apiResponse(error.status, { error: error.message }, error.headers);
  }
  if (error instanceof SupabaseError) {
    if (error.status === 401 || error.status === 403) {
      return apiResponse(401, { error: 'Authentication is required' });
    }
    return apiResponse(502, { error: 'The delivery database is temporarily unavailable' });
  }
  return apiResponse(500, { error: 'The request could not be completed' });
}

function routeLabel(request: Request): string {
  try {
    return new URL(request.url).pathname.replace(
      /\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,
      '/:id',
    );
  } catch {
    return 'unknown';
  }
}

function logRequest(
  request: Request,
  requestId: string,
  status: number,
  startedAt: number,
  error?: unknown,
): void {
  const payload: JsonObject = {
    timestamp: new Date().toISOString(),
    event: 'http_request',
    request_id: requestId,
    method: request.method,
    route: routeLabel(request),
    status,
    duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
  };
  if (error) payload.error_class = error instanceof Error ? error.name : typeof error;
  console.log(JSON.stringify(payload));
}

export function apiRoute<Parameters extends RouteParameters = RouteParameters>(
  handler: ApiHandler<Parameters>,
  options: ApiRouteOptions = {},
): (
  request: NextRequest,
  route: RouteContext<Parameters>,
) => Promise<Response> {
  const authenticated = options.authenticated ?? true;
  return async (request, route) => {
    const requestId = randomUUID().replaceAll('-', '');
    const startedAt = performance.now();
    let response: Response;
    let caught: unknown;
    try {
      const token = bearerToken(request);
      let user: SupabaseUser | null = null;
      let userClient: SupabaseUserClient | null = null;

      if (authenticated) {
        const credential = token
          ? createHash('sha256').update(token).digest('hex').slice(0, 24)
          : null;
        let retryAfter = rateLimiter.retryAfter(`preauth-client:${clientIp(request)}`, {
          limit: PREAUTH_REQUEST_LIMIT * 3,
          window: PREAUTH_REQUEST_WINDOW_SECONDS,
        });
        if (!retryAfter && credential) {
          retryAfter = rateLimiter.retryAfter(`preauth-credential:${credential}`, {
            limit: PREAUTH_REQUEST_LIMIT,
            window: PREAUTH_REQUEST_WINDOW_SECONDS,
          });
        }
        if (retryAfter) {
          throw new HttpError(
            429,
            'Too many authentication attempts. Try again shortly.',
            { 'Retry-After': String(retryAfter) },
          );
        }

        let auth;
        try {
          auth = authenticator();
        } catch (error) {
          throw new HttpError(503, 'Supabase authentication is not configured', undefined, {
            cause: error,
          });
        }
        if (!auth) throw new HttpError(503, 'Supabase authentication is not configured');
        if (!token) throw new HttpError(401, 'Authentication is required');
        try {
          user = await auth.validate(token);
        } catch (error) {
          if (error instanceof SupabaseAuthError) {
            throw new HttpError(401, 'Authentication is required', undefined, { cause: error });
          }
          throw error;
        }
        const policy = ratePolicy(request.method, new URL(request.url).pathname);
        retryAfter = rateLimiter.retryAfter(`${user.id}:${policy.bucket}`, {
          limit: policy.limit,
          window: policy.window,
        });
        if (retryAfter) {
          throw new HttpError(429, 'Too many requests. Try again shortly.', {
            'Retry-After': String(retryAfter),
          });
        }
        userClient = auth.userClient(token);
      }

      let service: SupabaseServiceClient | null = null;
      if (options.loadService ?? true) {
        try {
          service = serviceClient();
        } catch (error) {
          throw new HttpError(503, 'The delivery database is not configured', undefined, {
            cause: error,
          });
        }
      }
      if (options.serviceRequired && !service) {
        throw new HttpError(503, 'The delivery database is not configured');
      }
      response = await handler({
        request,
        route,
        requestId,
        user,
        token,
        userClient,
        service,
      });
    } catch (error) {
      caught = error;
      response = failure(error);
    }

    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', requestId);
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
    const finalized = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    logRequest(request, requestId, finalized.status, startedAt, caught);
    return finalized;
  };
}

export async function readJsonObject(request: Request): Promise<JsonObject> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isInteger(length) || length <= 0 || length > MAX_JSON_BODY) {
      throw new HttpError(400, 'Invalid request size');
    }
  }
  let text: string;
  try {
    text = await request.text();
  } catch (error) {
    throw new HttpError(400, 'Send a valid JSON object', undefined, { cause: error });
  }
  if (!text || new TextEncoder().encode(text).byteLength > MAX_JSON_BODY) {
    throw new HttpError(400, 'Invalid request size');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new HttpError(400, 'Send a valid JSON object', undefined, { cause: error });
  }
  if (!isRecord(payload)) throw new HttpError(400, 'Send a valid JSON object');
  return payload;
}

export function requireUser(context: ApiContext): SupabaseUser {
  if (!context.user) throw new HttpError(401, 'Authentication is required');
  return context.user;
}

export function requireUserClient(context: ApiContext): SupabaseUserClient {
  if (!context.userClient) throw new HttpError(401, 'Authentication is required');
  return context.userClient;
}

export function requireService(context: ApiContext): SupabaseServiceClient {
  if (!context.service) throw new HttpError(503, 'The delivery database is not configured');
  return context.service;
}

export function parseUuid(value: string, label: string): string {
  if (!UUID.test(value)) throw new HttpError(400, `Invalid ${label}`);
  return value.toLowerCase();
}

export function validationError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  throw new HttpError(400, errorMessage(error), undefined, { cause: error });
}
