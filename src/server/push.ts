import { connect, constants as http2Constants } from 'node:http2';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import webpush from 'web-push';
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

const NATIVE_COPY: Record<string, Record<string, string>> = {
  en: {
    test_title: 'Notifications are on',
    test_body: 'Swiss Delivery Tracker will alert this iPhone when tracking changes.',
    update: 'Parcel update',
    ...STAGE_LABELS,
  },
  de: {
    test_title: 'Benachrichtigungen sind aktiv',
    test_body: 'Swiss Delivery Tracker meldet Änderungen an Sendungen auf diesem iPhone.',
    update: 'Paketaktualisierung',
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
    test_body: 'Swiss Delivery Tracker signalera les changements de suivi sur cet iPhone.',
    update: 'Mise à jour du colis',
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
    test_body: 'Swiss Delivery Tracker segnalerà le modifiche di tracciamento su questo iPhone.',
    update: 'Aggiornamento del pacco',
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

export class WebPushNotificationService {
  constructor(
    readonly client: SupabaseServiceClient,
    readonly publicKey: string,
    readonly privateKey: string,
    readonly subject: string,
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
      body: 'Swiss Delivery Tracker will alert this device when tracking changes.',
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
    const stage = STAGE_LABELS[stringField(row, 'stage')] ?? 'Tracking update';
    const location = notificationText(row.location, 140);
    const packageId = stringField(row, 'package_id');
    return {
      title: notificationText(row.label || 'Parcel update', 80),
      body: notificationText(location ? `${stage} · ${location}` : stage, 220),
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
    const copy = this.copy(row);
    const stage = copy[stringField(row, 'stage')] ?? copy.update!;
    const location = notificationText(row.location, 140);
    return this.payload(
      notificationText(row.label || copy.update, 80),
      notificationText(location ? `${stage} · ${location}` : stage, 220),
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
    const locale = (stringField(row, 'locale') || 'en').split('-', 1)[0]!.toLowerCase();
    return NATIVE_COPY[locale] ?? NATIVE_COPY.en!;
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

export class CompositePushNotificationService {
  constructor(
    readonly web: WebPushNotificationService | null,
    readonly native: NativePushNotificationService | null,
  ) {}

  async dispatch(): Promise<PushSummary> {
    const combined = emptySummary();
    for (const service of [this.web, this.native]) {
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
      service: new CompositePushNotificationService(web, native),
    };
  }
  return globalPush.__deliveryPushRuntime.service;
}

export function pushConfigurationError(error: unknown): Error {
  return new Error(`Push notification configuration failed: ${errorMessage(error)}`, {
    cause: error,
  });
}
