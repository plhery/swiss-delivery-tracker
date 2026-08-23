import { AUTOMATIC_CARRIER_IDS } from './carriers';
import { isRecord, type JsonObject } from './types';

const REQUEST_TIMEOUT_MS = 20_000;
const PACKAGE_SELECT = [
  'id',
  'tracking_number',
  'label',
  'carrier',
  'created_at',
  'expected_delivery',
  'last_status_text',
  'last_synced_at',
  'sync_status',
  'sync_error',
  'tracking_url',
  'dpd_postcode',
  'carrier_data',
  'archived_at',
  'notifications_muted',
  'tracking_events(id,package_id,stage,description,location,occurred_at)',
].join(',');

export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SupabaseError';
  }
}

function query(
  entries: ReadonlyArray<readonly [string, string]> | Record<string, string>,
): string {
  if (Array.isArray(entries)) {
    return new URLSearchParams(
      entries.map(([key, value]) => [key, value]),
    ).toString();
  }
  return new URLSearchParams(entries as Record<string, string>).toString();
}

function rows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export class SupabaseClient {
  readonly url: string;

  constructor(
    url: string,
    readonly apiKey: string,
    readonly accessToken = apiKey,
    readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.url = url.replace(/\/+$/, '');
  }

  async request<T = unknown>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      prefer?: string;
    } = {},
  ): Promise<T | null> {
    const method = options.method ?? 'GET';
    const headers = new Headers({
      Accept: 'application/json',
      apikey: this.apiKey,
      Authorization: `Bearer ${this.accessToken}`,
    });
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set('Content-Type', 'application/json');
    }
    if (options.prefer) headers.set('Prefer', options.prefer);

    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method,
        headers,
        body,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SupabaseError('The delivery database is unreachable', undefined, undefined, {
        cause: error,
      });
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        if (response.ok) {
          throw new SupabaseError('The delivery database returned invalid JSON', response.status, undefined, {
            cause: error,
          });
        }
      }
    }

    if (!response.ok) {
      const code = isRecord(payload) && typeof payload.code === 'string' ? payload.code : undefined;
      throw new SupabaseError(
        `Supabase ${method} request failed (${response.status})`,
        response.status,
        code,
      );
    }
    return payload as T | null;
  }

  async listPackages(includeArchived = false): Promise<JsonObject[]> {
    const params: Array<[string, string]> = [
      ['select', PACKAGE_SELECT],
      ['order', 'created_at.desc'],
    ];
    if (!includeArchived) params.push(['archived_at', 'is.null']);
    return rows(await this.request(`/rest/v1/packages?${query(params)}`));
  }

  async getPackage(packageId: string): Promise<JsonObject | null> {
    const params: Array<[string, string]> = [
      ['select', PACKAGE_SELECT],
      ['id', `eq.${packageId}`],
      ['limit', '1'],
    ];
    return rows(await this.request(`/rest/v1/packages?${query(params)}`))[0] ?? null;
  }

  async createPackage(
    trackingNumber: string,
    label: string,
    carrier: string,
    trackingUrl?: string | null,
    dpdPostcode?: string | null,
  ): Promise<JsonObject> {
    const body: JsonObject = {
      tracking_number: trackingNumber,
      label,
      carrier,
    };
    if (trackingUrl) body.tracking_url = trackingUrl;
    if (dpdPostcode) body.dpd_postcode = dpdPostcode;
    const created = rows(await this.request('/rest/v1/packages', {
      method: 'POST',
      body,
      prefer: 'return=representation',
    }));
    const id = created[0]?.id;
    if (typeof id !== 'string') throw new SupabaseError('Supabase did not return the new package');
    const parcel = await this.getPackage(id);
    if (!parcel) throw new SupabaseError('The new package could not be reloaded');
    return parcel;
  }

  async archivePackage(packageId: string): Promise<void> {
    await this.updatePackage(packageId, { archived_at: new Date().toISOString() });
  }

  async restorePackage(packageId: string): Promise<void> {
    await this.updatePackage(packageId, { archived_at: null });
  }

  async deleteArchivedPackage(packageId: string): Promise<boolean> {
    const params = query({ id: `eq.${packageId}`, archived_at: 'not.is.null' });
    const deleted = rows(await this.request(`/rest/v1/packages?${params}`, {
      method: 'DELETE',
      prefer: 'return=representation',
    }));
    return deleted.length === 1;
  }

  async deletePackage(packageId: string): Promise<boolean> {
    const deleted = rows(await this.request(`/rest/v1/packages?${query({ id: `eq.${packageId}` })}`, {
      method: 'DELETE',
      prefer: 'return=representation',
    }));
    return deleted.length === 1;
  }

  async archiveDeliveredBefore(cutoff: Date): Promise<number> {
    if (!Number.isFinite(cutoff.getTime())) throw new TypeError('Archive cutoff must be valid');
    const params = query([
      ['archived_at', 'is.null'],
      ['current_stage', 'eq.delivered'],
      ['last_synced_at', `lt.${cutoff.toISOString()}`],
    ]);
    const archived = rows(await this.request(`/rest/v1/packages?${params}`, {
      method: 'PATCH',
      body: { archived_at: new Date().toISOString() },
      prefer: 'return=representation',
    }));
    return archived.length;
  }

  async listActivePackages(): Promise<JsonObject[]> {
    const params = query([
      [
        'select',
        'id,user_id,tracking_number,label,carrier,current_stage,tracking_url,dpd_postcode,last_synced_at,carrier_data',
      ],
      ['archived_at', 'is.null'],
      ['or', '(current_stage.not.in.(delivered,returned),last_status_text.eq.TO_BE_DELIVERED)'],
      ['carrier', `in.(${[...AUTOMATIC_CARRIER_IDS].sort().join(',')})`],
      ['order', 'last_synced_at.asc.nullsfirst,created_at.asc'],
    ]);
    return rows(await this.request(`/rest/v1/packages?${params}`));
  }

  async updatePackage(packageId: string, values: JsonObject): Promise<void> {
    await this.request(`/rest/v1/packages?${query({ id: `eq.${packageId}` })}`, {
      method: 'PATCH',
      body: values,
      prefer: 'return=minimal',
    });
  }

  async insertEvents(events: JsonObject[]): Promise<void> {
    if (events.length === 0) return;
    await this.request(`/rest/v1/tracking_events?${query({
      on_conflict: 'package_id,provider_event_id',
    })}`, {
      method: 'POST',
      body: events,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }

  async deleteEventsByDescriptions(packageId: string, descriptions: Set<string>): Promise<void> {
    if (descriptions.size === 0) return;
    const params = query([
      ['package_id', `eq.${packageId}`],
      ['description', `in.(${[...descriptions].sort().join(',')})`],
    ]);
    await this.request(`/rest/v1/tracking_events?${params}`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    });
  }

  async upsertPushSubscription(
    userId: string,
    endpoint: string,
    p256dh: string,
    auth: string,
    userAgent?: string | null,
  ): Promise<JsonObject> {
    const now = new Date().toISOString();
    const result = rows(await this.request(`/rest/v1/push_subscriptions?${query({
      on_conflict: 'endpoint',
    })}`, {
      method: 'POST',
      body: {
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent: userAgent ?? null,
        subscribed_at: now,
        disabled_at: null,
        last_error: null,
        updated_at: now,
      },
      prefer: 'resolution=merge-duplicates,return=representation',
    }));
    if (!result[0]) throw new SupabaseError('Supabase did not return the push subscription');
    return result[0];
  }

  async deletePushSubscription(userId: string, endpoint: string): Promise<void> {
    const params = query({ user_id: `eq.${userId}`, endpoint: `eq.${endpoint}` });
    await this.request(`/rest/v1/push_subscriptions?${params}`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    });
  }

  async upsertNativePushDevice(
    userId: string,
    token: string,
    environment: string,
    locale: string,
    deviceName?: string | null,
  ): Promise<JsonObject> {
    const now = new Date().toISOString();
    const result = rows(await this.request(`/rest/v1/native_push_devices?${query({
      on_conflict: 'environment,token',
    })}`, {
      method: 'POST',
      body: {
        user_id: userId,
        token,
        environment,
        locale,
        device_name: deviceName ?? null,
        subscribed_at: now,
        disabled_at: null,
        last_error: null,
        updated_at: now,
      },
      prefer: 'resolution=merge-duplicates,return=representation',
    }));
    if (!result[0]) throw new SupabaseError('Supabase did not return the native push device');
    return result[0];
  }

  async deleteNativePushDevice(userId: string, token: string): Promise<void> {
    const params = query({ user_id: `eq.${userId}`, token: `eq.${token}` });
    await this.request(`/rest/v1/native_push_devices?${params}`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    });
  }

  async listPendingPushNotifications(): Promise<JsonObject[]> {
    const params = query({ select: '*', order: 'event_created_at.asc', limit: '1000' });
    return rows(await this.request(`/rest/v1/pending_push_notifications?${params}`));
  }

  async listPendingNativePushNotifications(): Promise<JsonObject[]> {
    const params = query({ select: '*', order: 'event_created_at.asc', limit: '1000' });
    return rows(await this.request(`/rest/v1/pending_native_push_notifications?${params}`));
  }

  async recordPushDeliveries(subscriptionId: string, eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.request(`/rest/v1/push_deliveries?${query({
      on_conflict: 'subscription_id,event_id',
    })}`, {
      method: 'POST',
      body: eventIds.map((eventId) => ({ subscription_id: subscriptionId, event_id: eventId })),
      prefer: 'resolution=ignore-duplicates,return=minimal',
    });
  }

  async recordNativePushDeliveries(deviceId: string, eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.request(`/rest/v1/native_push_deliveries?${query({
      on_conflict: 'device_id,event_id',
    })}`, {
      method: 'POST',
      body: eventIds.map((eventId) => ({ device_id: deviceId, event_id: eventId })),
      prefer: 'resolution=ignore-duplicates,return=minimal',
    });
  }

  async updatePushSubscription(subscriptionId: string, values: JsonObject): Promise<void> {
    await this.request(`/rest/v1/push_subscriptions?${query({ id: `eq.${subscriptionId}` })}`, {
      method: 'PATCH',
      body: { ...values, updated_at: new Date().toISOString() },
      prefer: 'return=minimal',
    });
  }

  async updateNativePushDevice(deviceId: string, values: JsonObject): Promise<void> {
    await this.request(`/rest/v1/native_push_devices?${query({ id: `eq.${deviceId}` })}`, {
      method: 'PATCH',
      body: { ...values, updated_at: new Date().toISOString() },
      prefer: 'return=minimal',
    });
  }

  async deleteAuthUser(userId: string): Promise<void> {
    await this.request(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }
}

export class SupabaseServiceClient extends SupabaseClient {
  async enqueueSyncJob(options: {
    userId?: string | null;
    packageId?: string | null;
    scheduled?: boolean;
  }): Promise<{ row: JsonObject; queued: boolean }> {
    const scheduled = options.scheduled ?? false;
    let kind: string;
    let dedupeKey: string;
    let priority: number;
    if (scheduled) {
      if (options.userId != null || options.packageId != null) {
        throw new TypeError('Scheduled sync jobs cannot target an account');
      }
      kind = 'scheduled';
      dedupeKey = 'scheduled';
      priority = -10;
    } else {
      if (!options.userId || !options.packageId) {
        throw new TypeError('Package sync jobs require an owner and package');
      }
      kind = 'package';
      dedupeKey = `package:${options.packageId}`;
      priority = 10;
    }

    const created = rows(await this.request('/rest/v1/sync_jobs?on_conflict=dedupe_key', {
      method: 'POST',
      body: {
        user_id: options.userId ?? null,
        package_id: options.packageId ?? null,
        kind,
        dedupe_key: dedupeKey,
        priority,
      },
      prefer: 'resolution=ignore-duplicates,return=representation',
    }));
    if (created[0]) return { row: created[0], queued: true };

    const params = query({
      select: 'id,user_id,package_id,kind,state,requested_at',
      dedupe_key: `eq.${dedupeKey}`,
      limit: '1',
    });
    const existing = rows(await this.request(`/rest/v1/sync_jobs?${params}`));
    if (!existing[0]) throw new SupabaseError('The durable sync job could not be queued');
    return { row: existing[0], queued: false };
  }

  async claimSyncJob(workerId: string, leaseSeconds = 900): Promise<JsonObject | null> {
    const result = rows(await this.request('/rest/v1/rpc/claim_sync_job', {
      method: 'POST',
      body: { p_worker_id: workerId, p_lease_seconds: leaseSeconds },
    }));
    return result[0] ?? null;
  }

  async finishSyncJob(
    jobId: string,
    workerId: string,
    options: { result?: JsonObject | null; error?: string | null },
  ): Promise<void> {
    const params = query({ id: `eq.${jobId}`, locked_by: `eq.${workerId}` });
    await this.request(`/rest/v1/sync_jobs?${params}`, {
      method: 'PATCH',
      body: {
        state: options.error ? 'failed' : 'succeeded',
        completed_at: new Date().toISOString(),
        lease_until: null,
        locked_by: null,
        dedupe_key: null,
        result: options.result ?? null,
        last_error: options.error?.slice(0, 500) ?? null,
      },
      prefer: 'return=minimal',
    });
  }

  async getSyncJob(jobId: string, userId: string): Promise<JsonObject | null> {
    const params = query({
      select: 'id,user_id,package_id,state,requested_at,started_at,completed_at,result,last_error',
      id: `eq.${jobId}`,
      user_id: `eq.${userId}`,
      limit: '1',
    });
    return rows(await this.request(`/rest/v1/sync_jobs?${params}`))[0] ?? null;
  }

  async pendingSyncJobCount(userId?: string | null): Promise<number> {
    const params: Record<string, string> = {
      select: 'id',
      state: 'in.(queued,running)',
      limit: '1000',
    };
    if (userId) params.user_id = `eq.${userId}`;
    return rows(await this.request(`/rest/v1/sync_jobs?${query(params)}`)).length;
  }
}

export class SupabaseUserClient extends SupabaseClient {
  override async createPackage(
    trackingNumber: string,
    label: string,
    carrier: string,
    trackingUrl?: string | null,
    dpdPostcode?: string | null,
  ): Promise<JsonObject> {
    let result = await this.request('/rest/v1/rpc/create_owned_package', {
      method: 'POST',
      body: {
        p_tracking_number: trackingNumber,
        p_label: label,
        p_carrier: carrier,
        p_tracking_url: trackingUrl ?? null,
        p_dpd_postcode: dpdPostcode ?? null,
      },
    });
    if (Array.isArray(result) && result.length === 1) [result] = result;
    if (!isRecord(result) || typeof result.id !== 'string') {
      throw new SupabaseError('Supabase did not return the new package');
    }
    const parcel = await this.getPackage(result.id);
    if (!parcel) throw new SupabaseError('The new package could not be reloaded');
    return parcel;
  }

  override async updatePackage(packageId: string, values: JsonObject): Promise<void> {
    const keys = Object.keys(values);
    let changed: unknown;
    if (keys.length === 1 && keys[0] === 'label' && typeof values.label === 'string') {
      changed = await this.request('/rest/v1/rpc/rename_owned_package', {
        method: 'POST',
        body: { p_package_id: packageId, p_label: values.label },
      });
    } else if (keys.length === 1 && keys[0] === 'archived_at') {
      changed = await this.request('/rest/v1/rpc/set_owned_package_archived', {
        method: 'POST',
        body: { p_package_id: packageId, p_archived: values.archived_at != null },
      });
    } else if (
      keys.length === 1
      && keys[0] === 'notifications_muted'
      && typeof values.notifications_muted === 'boolean'
    ) {
      changed = await this.request('/rest/v1/rpc/set_owned_package_notifications_muted', {
        method: 'POST',
        body: { p_package_id: packageId, p_muted: values.notifications_muted },
      });
    } else {
      throw new TypeError('User-scoped package updates must use an approved mutation');
    }
    if (changed !== true) throw new SupabaseError('Package not found', 404);
  }

  override async deleteArchivedPackage(packageId: string): Promise<boolean> {
    return await this.request('/rest/v1/rpc/delete_owned_archived_package', {
      method: 'POST',
      body: { p_package_id: packageId },
    }) === true;
  }

  override async deletePackage(packageId: string): Promise<boolean> {
    return await this.request('/rest/v1/rpc/delete_owned_package', {
      method: 'POST',
      body: { p_package_id: packageId },
    }) === true;
  }

  async getNotificationPreferences(): Promise<JsonObject> {
    const params = query({
      select: 'enabled_stages,quiet_hours_start,quiet_hours_end,timezone',
      limit: '1',
    });
    const result = rows(await this.request(`/rest/v1/notification_preferences?${params}`));
    return result[0] ?? {
      enabled_stages: [
        'registered',
        'accepted',
        'in_transit',
        'customs',
        'out_for_delivery',
        'failed_attempt',
        'ready_for_pickup',
        'delivered',
        'returned',
      ],
      quiet_hours_start: null,
      quiet_hours_end: null,
      timezone: 'Europe/Zurich',
    };
  }

  async setNotificationPreferences(
    enabledStages: string[],
    quietHoursStart: string | null,
    quietHoursEnd: string | null,
    timezone: string,
  ): Promise<JsonObject> {
    let result = await this.request('/rest/v1/rpc/set_owned_notification_preferences', {
      method: 'POST',
      body: {
        p_enabled_stages: enabledStages,
        p_quiet_hours_start: quietHoursStart,
        p_quiet_hours_end: quietHoursEnd,
        p_timezone: timezone,
      },
    });
    if (Array.isArray(result) && result.length === 1) [result] = result;
    if (!isRecord(result)) {
      throw new SupabaseError('Supabase did not return notification preferences');
    }
    return result;
  }
}
