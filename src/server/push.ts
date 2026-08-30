import 'server-only';

import { connect, constants as http2Constants } from 'node:http2';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import { DateTime, IANAZone } from 'luxon';
import webpush from 'web-push';
import { CARRIER_CAPABILITIES } from '../generated/apiContract';
import type { SupabaseServiceClient } from './supabase';
import { errorMessage, isRecord, type JsonObject } from './types';

const STAGE_LABELS: Record<string, string> = {
  pending: 'Not announced yet',
  registered: 'Shipment announced',
  accepted: 'Parcel accepted',
  in_transit: 'Parcel in transit',
  customs: 'At customs',
  out_for_delivery: 'Out for delivery',
  ready_for_pickup: 'Ready for pickup',
  delivered: 'Delivered',
  failed_attempt: 'Delivery attempt failed',
  returned: 'Returning to sender',
};

const PUSH_COPY: Record<string, Record<string, string>> = {
  en: {
    test_title: 'Notifications are on',
    test_body: 'Delivery Tracker will alert this iPhone when tracking changes.',
    update: 'Parcel update',
    eta: 'ETA {{date}}',
    eta_changed: 'New ETA: {{date}}',
    today: 'today',
    tomorrow: 'tomorrow',
    ...STAGE_LABELS,
  },
  de: {
    test_title: 'Benachrichtigungen sind aktiv',
    test_body: 'Delivery Tracker meldet Änderungen an Sendungen auf diesem iPhone.',
    update: 'Paketaktualisierung',
    eta: 'Voraussichtliche Zustellung: {{date}}',
    eta_changed: 'Neue Lieferprognose: {{date}}',
    today: 'heute',
    tomorrow: 'morgen',
    pending: 'Noch nicht angekündigt',
    registered: 'Sendung angekündigt',
    accepted: 'Paket angenommen',
    in_transit: 'Paket unterwegs',
    customs: 'Beim Zoll',
    out_for_delivery: 'In Zustellung',
    ready_for_pickup: 'Abholbereit',
    delivered: 'Zugestellt',
    failed_attempt: 'Zustellversuch fehlgeschlagen',
    returned: 'Rücksendung an Absender',
  },
  fr: {
    test_title: 'Les notifications sont activées',
    test_body: 'Delivery Tracker signalera les changements de suivi sur cet iPhone.',
    update: 'Mise à jour du colis',
    eta: 'Livraison prévue : {{date}}',
    eta_changed: 'Nouvelle date estimée : {{date}}',
    today: 'aujourd’hui',
    tomorrow: 'demain',
    pending: 'Pas encore annoncé',
    registered: 'Envoi annoncé',
    accepted: 'Colis accepté',
    in_transit: 'Colis en transit',
    customs: 'À la douane',
    out_for_delivery: 'En cours de livraison',
    ready_for_pickup: 'Prêt à être retiré',
    delivered: 'Livré',
    failed_attempt: 'Échec de la tentative de livraison',
    returned: 'Retour à l’expéditeur',
  },
  it: {
    test_title: 'Le notifiche sono attive',
    test_body: 'Delivery Tracker segnalerà le modifiche di tracciamento su questo iPhone.',
    update: 'Aggiornamento del pacco',
    eta: 'Consegna prevista: {{date}}',
    eta_changed: 'Nuova data stimata: {{date}}',
    today: 'oggi',
    tomorrow: 'domani',
    pending: 'Non ancora annunciato',
    registered: 'Spedizione annunciata',
    accepted: 'Pacco accettato',
    in_transit: 'Pacco in transito',
    customs: 'Alla dogana',
    out_for_delivery: 'In consegna',
    ready_for_pickup: 'Pronto per il ritiro',
    delivered: 'Consegnato',
    failed_attempt: 'Tentativo di consegna non riuscito',
    returned: 'Restituzione al mittente',
  },
};

export interface PushSummary {
  attempted: number;
  sent: number;
  failed: number;
  expired: number;
}

function emptySummary(): PushSummary {
  return { attempted: 0, sent: 0, failed: 0, expired: 0 };
}

export function notificationText(value: unknown, limit: number): string {
  const cleaned = String(value ?? '').trim().split(/\s+/).filter(Boolean).join(' ');
  const characters = [...cleaned];
  if (characters.length <= limit) return cleaned;
  return `${characters.slice(0, limit - 1).join('').trimEnd()}…`;
}

function stringField(row: JsonObject, name: string): string {
  return typeof row[name] === 'string' ? row[name] : '';
}

function carrierDisplayName(value: unknown): string {
  const carrier = typeof value === 'string' ? value : '';
  if (Object.hasOwn(CARRIER_CAPABILITIES, carrier)) {
    return CARRIER_CAPABILITIES[carrier as keyof typeof CARRIER_CAPABILITIES].displayName;
  }
  return carrier || 'Carrier';
}

const NOTIFICATION_LANGUAGE_TAGS: Record<string, string> = {
  en: 'en-CH',
  de: 'de-CH',
  fr: 'fr-CH',
  it: 'it-CH',
};

function notificationLocale(value: unknown): string {
  const locale = typeof value === 'string'
    ? value.trim().split(/[-_]/, 1)[0]!.toLowerCase()
    : 'en';
  return PUSH_COPY[locale] ? locale : 'en';
}

export function notificationExpectedDelivery(
  value: unknown,
  locale = 'en',
  timezone = 'Europe/Zurich',
  now = Date.now(),
): string {
  const cleaned = notificationText(value, 100);
  if (!cleaned) return '';
  const language = notificationLocale(locale);
  const copy = PUSH_COPY[language]!;
  const languageTag = NOTIFICATION_LANGUAGE_TAGS[language]!;
  const zone = IANAZone.isValidZone(timezone) ? timezone : 'Europe/Zurich';
  const today = DateTime.fromMillis(now, { zone });

  const formattedDay = (raw: string): string | null => {
    const expected = DateTime.fromISO(raw, { zone });
    if (!expected.isValid || !today.isValid) return null;
    if (expected.toISODate() === today.toISODate()) return copy.today!;
    if (expected.toISODate() === today.plus({ days: 1 }).toISODate()) return copy.tomorrow!;
    return expected.setLocale(languageTag).toLocaleString(DateTime.DATE_SHORT);
  };

  const window = /^(\d{4}-\d{2}-\d{2})[ T]+(\d{2}:\d{2})(?:[–-](\d{2}:\d{2}))?$/.exec(
    cleaned,
  );
  if (window) {
    const day = formattedDay(window[1]!);
    if (!day) return cleaned;
    return `${day}, ${window[2]}${window[3] ? `–${window[3]}` : ''}`;
  }
  return formattedDay(cleaned) ?? cleaned;
}

function notificationBody(
  row: JsonObject,
  stage: string,
  copy: Record<string, string>,
  locale: string,
  now: number,
): string {
  const location = notificationText(row.location, 140);
  const primary = location ? `${stage} · ${location}` : stage;
  const expected = notificationExpectedDelivery(
    row.expected_delivery,
    locale,
    stringField(row, 'timezone') || 'Europe/Zurich',
    now,
  );
  if (!expected) return notificationText(primary, 220);

  const template = row.expected_delivery_changed === true ? copy.eta_changed : copy.eta;
  const eta = notificationText((template ?? 'ETA {{date}}').replace('{{date}}', expected), 100);
  const suffix = ` · ${eta}`;
  const primaryLimit = 220 - [...suffix].length;
  if (primaryLimit <= 0) return notificationText(eta, 220);
  return `${notificationText(primary, primaryLimit)}${suffix}`;
}

export class WebPushNotificationService {
  constructor(
    readonly client: SupabaseServiceClient,
    readonly publicKey: string,
    readonly privateKey: string,
    readonly subject: string,
    readonly now: () => number = () => Date.now(),
  ) {}

  async dispatch(): Promise<PushSummary> {
    const grouped = new Map<string, JsonObject[]>();
    for (const row of await this.client.listPendingPushNotifications()) {
      const key = JSON.stringify([stringField(row, 'subscription_id'), stringField(row, 'package_id')]);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    const summary = emptySummary();
    for (const events of grouped.values()) {
      const newest = [...events].sort(
        (left, right) => stringField(right, 'event_created_at').localeCompare(
          stringField(left, 'event_created_at'),
        ),
      )[0]!;
      const subscriptionId = stringField(newest, 'subscription_id');
      summary.attempted += 1;
      try {
        await this.send(newest);
        await this.client.recordPushDeliveries(
          subscriptionId,
          events.map((event) => stringField(event, 'event_id')).filter(Boolean),
        );
        await this.client.updatePushSubscription(subscriptionId, {
          last_success_at: new Date().toISOString(),
          last_error: null,
        });
        summary.sent += 1;
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number(error.statusCode)
          : 0;
        if (status === 404 || status === 410) {
          await this.client.updatePushSubscription(subscriptionId, {
            disabled_at: new Date().toISOString(),
            last_error: 'Push endpoint expired',
          });
          summary.expired += 1;
        } else {
          await this.client.updatePushSubscription(subscriptionId, {
            last_error: 'Push delivery failed',
          });
          summary.failed += 1;
        }
      }
    }
    return summary;
  }

  async sendTest(subscription: JsonObject): Promise<void> {
    await this.send(subscription, {
      title: 'Notifications are on',
      body: 'Delivery Tracker will alert this device when tracking changes.',
      tag: 'parcel-post-ready',
      data: { url: '/' },
    });
  }

  async send(row: JsonObject, payload?: JsonObject): Promise<void> {
    await webpush.sendNotification(
      {
        endpoint: stringField(row, 'endpoint'),
        keys: {
          p256dh: stringField(row, 'p256dh'),
          auth: stringField(row, 'auth'),
        },
      },
      JSON.stringify(payload ?? this.payload(row)),
      {
        TTL: 86_400,
        timeout: 15_000,
        vapidDetails: {
          subject: this.subject,
          publicKey: this.publicKey,
          privateKey: this.privateKey,
        },
      },
    );
  }

  payload(row: JsonObject): JsonObject {
    const copy = PUSH_COPY.en!;
    const stage = copy[stringField(row, 'stage')] ?? 'Tracking update';
    const packageId = stringField(row, 'package_id');
    return {
      title: notificationText(row.label || 'Parcel update', 80),
      body: notificationBody(row, stage, copy, 'en', this.now()),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: `parcel-${packageId}`,
      data: { url: `/?parcel=${packageId}` },
    };
  }
}

export class APNsError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reason = '',
  ) {
    super(reason || `APNs returned HTTP ${statusCode}`);
    this.name = 'APNsError';
  }
}

async function postApns(
  host: string,
  path: string,
  headers: Record<string, string>,
  payload: JsonObject,
  timeoutMs: number,
): Promise<{ status: number; reason: string }> {
  return await new Promise((resolve, reject) => {
    const session = connect(`https://${host}`);
    const finish = (error?: Error) => {
      session.close();
      if (error) reject(error);
    };
    const timeout = setTimeout(() => {
      session.destroy();
      reject(new Error('APNs request timed out'));
    }, timeoutMs);
    session.once('error', (error) => {
      clearTimeout(timeout);
      finish(error);
    });
    const request = session.request({
      [http2Constants.HTTP2_HEADER_METHOD]: 'POST',
      [http2Constants.HTTP2_HEADER_PATH]: path,
      ...headers,
    });
    let status = 0;
    const chunks: Buffer[] = [];
    let length = 0;
    request.on('response', (responseHeaders) => {
      status = Number(responseHeaders[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
    });
    request.on('data', (chunk: Buffer) => {
      length += chunk.byteLength;
      if (length <= 65_536) chunks.push(chunk);
      else request.close(http2Constants.NGHTTP2_CANCEL);
    });
    request.once('error', (error) => {
      clearTimeout(timeout);
      finish(error);
    });
    request.once('end', () => {
      clearTimeout(timeout);
      let reason = '';
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (isRecord(body) && typeof body.reason === 'string') reason = body.reason;
      } catch {
        // APNs error bodies are best effort; status remains authoritative.
      }
      session.close();
      resolve({ status, reason });
    });
    request.end(JSON.stringify(payload));
  });
}

export class NativePushNotificationService {
  static readonly EXPIRED_REASONS = new Set([
    'BadDeviceToken',
    'DeviceTokenNotForTopic',
    'Unregistered',
  ]);

  #privateKey: KeyObject;
  #cachedToken: { token: string; issuedAt: number } | null = null;

  constructor(
    readonly client: SupabaseServiceClient,
    readonly teamId: string,
    readonly keyId: string,
    privateKey: string,
    readonly bundleId: string,
    readonly now: () => number = () => Date.now() / 1_000,
  ) {
    try {
      const key = createPrivateKey(privateKey.replaceAll('\\n', '\n').trim());
      if (
        key.asymmetricKeyType !== 'ec'
        || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      ) throw new TypeError('APNS_PRIVATE_KEY must be a P-256 private key');
      this.#privateKey = key;
    } catch (error) {
      throw new TypeError('APNS_PRIVATE_KEY must be a P-256 private key', { cause: error });
    }
  }

  async dispatch(): Promise<PushSummary> {
    const grouped = new Map<string, JsonObject[]>();
    for (const row of await this.client.listPendingNativePushNotifications()) {
      const key = JSON.stringify([stringField(row, 'device_id'), stringField(row, 'package_id')]);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    const summary = emptySummary();
    for (const events of grouped.values()) {
      const newest = [...events].sort(
        (left, right) => stringField(right, 'event_created_at').localeCompare(
          stringField(left, 'event_created_at'),
        ),
      )[0]!;
      const deviceId = stringField(newest, 'device_id');
      if (newest.live_activity_delivered === true) {
        await this.client.recordNativePushDeliveries(
          deviceId,
          events.map((event) => stringField(event, 'event_id')).filter(Boolean),
        );
        continue;
      }
      summary.attempted += 1;
      try {
        await this.send(newest);
        await this.client.recordNativePushDeliveries(
          deviceId,
          events.map((event) => stringField(event, 'event_id')).filter(Boolean),
        );
        await this.client.updateNativePushDevice(deviceId, {
          last_success_at: new Date().toISOString(),
          last_error: null,
        });
        summary.sent += 1;
      } catch (error) {
        if (this.isExpired(error)) {
          await this.client.updateNativePushDevice(deviceId, {
            disabled_at: new Date().toISOString(),
            last_error: 'APNs device token expired',
          });
          summary.expired += 1;
        } else {
          await this.client.updateNativePushDevice(deviceId, {
            last_error: 'APNs delivery failed',
          });
          summary.failed += 1;
        }
      }
    }
    return summary;
  }

  async sendTest(device: JsonObject): Promise<void> {
    const copy = this.copy(device);
    await this.send(device, this.payload(copy.test_title!, copy.test_body!, null));
  }

  async send(row: JsonObject, payload?: JsonObject): Promise<void> {
    const environment = stringField(row, 'environment') || 'production';
    const host = environment === 'development'
      ? 'api.sandbox.push.apple.com'
      : 'api.push.apple.com';
    const packageId = stringField(row, 'package_id');
    const headers: Record<string, string> = {
      authorization: `bearer ${await this.providerToken()}`,
      'apns-topic': this.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(this.now()) + 86_400),
      'content-type': 'application/json',
    };
    if (packageId) headers['apns-collapse-id'] = packageId.slice(0, 64);
    const response = await postApns(
      host,
      `/3/device/${stringField(row, 'token')}`,
      headers,
      payload ?? this.eventPayload(row),
      15_000,
    );
    if (response.status !== 200) throw new APNsError(response.status, response.reason);
  }

  eventPayload(row: JsonObject): JsonObject {
    const locale = this.locale(row);
    const copy = this.copy(row);
    const stage = copy[stringField(row, 'stage')] ?? copy.update!;
    return this.payload(
      notificationText(row.label || copy.update, 80),
      notificationBody(row, stage, copy, locale, this.now() * 1_000),
      stringField(row, 'package_id'),
    );
  }

  payload(title: string, body: string, parcelId: string | null): JsonObject {
    const aps: JsonObject = {
      alert: { title, body },
      sound: 'default',
      badge: 1,
    };
    const payload: JsonObject = { aps };
    if (parcelId) {
      aps['thread-id'] = parcelId;
      payload.parcel_id = parcelId;
    }
    return payload;
  }

  copy(row: JsonObject): Record<string, string> {
    return PUSH_COPY[this.locale(row)] ?? PUSH_COPY.en!;
  }

  locale(row: JsonObject): string {
    return notificationLocale(stringField(row, 'locale'));
  }

  async providerToken(): Promise<string> {
    const issuedAt = Math.floor(this.now());
    if (this.#cachedToken && issuedAt - this.#cachedToken.issuedAt < 50 * 60) {
      return this.#cachedToken.token;
    }
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId })
      .setIssuer(this.teamId)
      .setIssuedAt(issuedAt)
      .sign(this.#privateKey);
    this.#cachedToken = { token, issuedAt };
    return token;
  }

  isExpired(error: unknown): boolean {
    return error instanceof APNsError
      && (error.statusCode === 410 || NativePushNotificationService.EXPIRED_REASONS.has(error.reason));
  }
}

type LiveActivityDeliveryKind = 'start' | 'update' | 'end';

const LIVE_ACTIVITY_PHASES = new Set([
  'out_for_delivery',
  'delivered',
  'failed_attempt',
  'ready_for_pickup',
  'returned',
]);

export class DeliveryLiveActivityNotificationService {
  constructor(
    readonly client: SupabaseServiceClient,
    readonly apns: NativePushNotificationService,
  ) {}

  async dispatch(): Promise<PushSummary> {
    const grouped = new Map<string, JsonObject[]>();
    for (const row of await this.client.listPendingLiveActivityEvents()) {
      const key = JSON.stringify([stringField(row, 'device_id'), stringField(row, 'package_id')]);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    const summary = emptySummary();
    for (const events of grouped.values()) {
      const newest = [...events].sort(
        (left, right) => stringField(right, 'event_created_at').localeCompare(
          stringField(left, 'event_created_at'),
        ),
      )[0]!;
      const kind = this.deliveryKind(newest);
      if (!kind) continue;
      const deviceId = stringField(newest, 'device_id');
      const updateTokenId = stringField(newest, 'update_token_id');
      summary.attempted += 1;
      try {
        await this.send(newest, kind);
        await this.client.recordLiveActivityDeliveries(events.map((event) => ({
          deviceId,
          eventId: stringField(event, 'event_id'),
          packageId: stringField(event, 'package_id'),
          deliveryKind: kind,
          eventCreatedAt: stringField(event, 'event_created_at'),
        })));
        if (kind === 'end' && updateTokenId) {
          await this.client.deleteLiveActivityTokenById(updateTokenId);
        } else if (updateTokenId) {
          await this.client.updateLiveActivityToken(updateTokenId, {
            last_success_at: new Date().toISOString(),
            last_error: null,
          });
        } else {
          await this.client.updateLiveActivityDevice(deviceId, {
            last_success_at: new Date().toISOString(),
            last_error: null,
          });
        }
        summary.sent += 1;
      } catch (error) {
        if (this.apns.isExpired(error)) {
          if (updateTokenId) await this.client.deleteLiveActivityTokenById(updateTokenId);
          else {
            await this.client.updateLiveActivityDevice(deviceId, {
              disabled_at: new Date().toISOString(),
              last_error: 'ActivityKit token expired',
            });
          }
          summary.expired += 1;
        } else {
          if (updateTokenId) {
            await this.client.updateLiveActivityToken(updateTokenId, {
              last_error: 'Live Activity delivery failed',
            });
          } else {
            await this.client.updateLiveActivityDevice(deviceId, {
              last_error: 'Live Activity delivery failed',
            });
          }
          summary.failed += 1;
        }
      }
    }
    return summary;
  }

  deliveryKind(row: JsonObject): LiveActivityDeliveryKind | null {
    const hasUpdateToken = Boolean(stringField(row, 'update_token'));
    if (stringField(row, 'stage') === 'out_for_delivery') {
      return hasUpdateToken ? 'update' : 'start';
    }
    return hasUpdateToken ? 'end' : null;
  }

  async send(row: JsonObject, kind = this.deliveryKind(row)): Promise<void> {
    if (!kind) return;
    const environment = stringField(row, 'environment') || 'production';
    const host = environment === 'development'
      ? 'api.sandbox.push.apple.com'
      : 'api.push.apple.com';
    const token = kind === 'start'
      ? stringField(row, 'push_to_start_token')
      : stringField(row, 'update_token');
    const response = await postApns(
      host,
      `/3/device/${token}`,
      {
        authorization: `bearer ${await this.apns.providerToken()}`,
        'apns-topic': `${this.apns.bundleId}.push-type.liveactivity`,
        'apns-push-type': 'liveactivity',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(this.apns.now()) + 3_600),
        'content-type': 'application/json',
      },
      this.payload(row, kind),
      15_000,
    );
    if (response.status !== 200) throw new APNsError(response.status, response.reason);
  }

  payload(row: JsonObject, kind: LiveActivityDeliveryKind): JsonObject {
    const timestamp = Math.floor(this.apns.now());
    const parcelId = stringField(row, 'package_id');
    const locale = this.apns.locale(row);
    const copy = this.apns.copy(row);
    const stage = stringField(row, 'stage');
    const status = copy[stage] ?? copy.update!;
    const expected = notificationExpectedDelivery(
      row.expected_delivery,
      locale,
      stringField(row, 'timezone') || 'Europe/Zurich',
      timestamp * 1_000,
    );
    const phase = LIVE_ACTIVITY_PHASES.has(stage) ? stage : 'ended';
    const contentState: JsonObject = {
      parcel: {
        id: parcelId,
        label: notificationText(row.label || copy.update, 80),
        carrier: notificationText(carrierDisplayName(row.carrier), 80),
        status: notificationText(status, 80),
        detail: notificationText(stage === 'out_for_delivery' && expected ? expected : status, 100),
        phase,
      },
      languageCode: locale,
    };
    const aps: JsonObject = {
      timestamp,
      event: kind,
      'content-state': contentState,
      'relevance-score': stage === 'out_for_delivery' ? 0.8 : 1,
    };
    if (kind === 'start') {
      aps['attributes-type'] = 'DeliveryActivityAttributes';
      aps.attributes = { parcelID: parcelId };
      aps['input-push-token'] = 1;
      aps['stale-date'] = timestamp + 30 * 60;
      aps.alert = {
        title: notificationText(row.label || copy.update, 80),
        body: notificationBody(row, status, copy, locale, timestamp * 1_000),
      };
    } else if (kind === 'update') {
      aps['stale-date'] = timestamp + 30 * 60;
    } else {
      const graceSeconds = stage === 'failed_attempt' || stage === 'ready_for_pickup'
        ? 60 * 60
        : LIVE_ACTIVITY_PHASES.has(stage) ? 30 * 60 : -1;
      aps['dismissal-date'] = timestamp + graceSeconds;
      const location = notificationText(row.location, 100);
      aps.alert = {
        title: notificationText(row.label || copy.update, 80),
        body: notificationText(location ? `${status} · ${location}` : status, 180),
      };
    }
    return { aps };
  }
}

export class CompositePushNotificationService {
  constructor(
    readonly web: WebPushNotificationService | null,
    readonly native: NativePushNotificationService | null,
    readonly liveActivities: DeliveryLiveActivityNotificationService | null,
  ) {}

  async dispatch(): Promise<PushSummary> {
    const combined = emptySummary();
    for (const service of [this.liveActivities, this.web, this.native]) {
      if (!service) continue;
      const summary = await service.dispatch();
      combined.attempted += summary.attempted;
      combined.sent += summary.sent;
      combined.failed += summary.failed;
      combined.expired += summary.expired;
    }
    return combined;
  }
}

interface PushRuntime {
  signature: string;
  client: SupabaseServiceClient;
  service: CompositePushNotificationService;
}

const globalPush = globalThis as typeof globalThis & {
  __deliveryPushRuntime?: PushRuntime;
};

export function pushServices(client: SupabaseServiceClient): CompositePushNotificationService {
  const webValues = {
    publicKey: process.env.VAPID_PUBLIC_KEY?.trim() ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY?.trim() ?? '',
    subject: process.env.VAPID_SUBJECT?.trim() || 'https://delivery.plhery.com',
  };
  const nativeValues = {
    teamId: process.env.APNS_TEAM_ID?.trim() ?? '',
    keyId: process.env.APNS_KEY_ID?.trim() ?? '',
    privateKey: process.env.APNS_PRIVATE_KEY?.trim() ?? '',
    bundleId: process.env.APNS_BUNDLE_ID?.trim() ?? '',
  };
  if (Boolean(webValues.publicKey) !== Boolean(webValues.privateKey)) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured together');
  }
  if (Object.values(nativeValues).some(Boolean) && !Object.values(nativeValues).every(Boolean)) {
    throw new Error('APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY and APNS_BUNDLE_ID are all required');
  }
  const signature = JSON.stringify([webValues, nativeValues]);
  if (
    globalPush.__deliveryPushRuntime?.signature !== signature
    || globalPush.__deliveryPushRuntime.client !== client
  ) {
    let web: WebPushNotificationService | null = null;
    if (webValues.publicKey && webValues.privateKey) {
      try {
        webpush.getVapidHeaders(
          'https://push.example.test',
          webValues.subject,
          webValues.publicKey,
          webValues.privateKey,
          'aes128gcm',
        );
      } catch (error) {
        throw new Error('VAPID keys are invalid', { cause: error });
      }
      web = new WebPushNotificationService(
        client,
        webValues.publicKey,
        webValues.privateKey,
        webValues.subject,
      );
    }
    const native = Object.values(nativeValues).every(Boolean)
      ? new NativePushNotificationService(
          client,
          nativeValues.teamId,
          nativeValues.keyId,
          nativeValues.privateKey,
          nativeValues.bundleId,
        )
      : null;
    globalPush.__deliveryPushRuntime = {
      signature,
      client,
      service: new CompositePushNotificationService(
        web,
        native,
        native ? new DeliveryLiveActivityNotificationService(client, native) : null,
      ),
    };
  }
  return globalPush.__deliveryPushRuntime.service;
}

export function pushConfigurationError(error: unknown): Error {
  return new Error(`Push notification configuration failed: ${errorMessage(error)}`, {
    cause: error,
  });
}
