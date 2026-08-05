import { carrierInfo, formatTrackingNumber } from '../lib/carriers';
import {
  localizedExpectedDelivery,
  localizedRelativeTime,
  useI18n,
} from '../i18n';
import { parcelDisplayStatus, parcelDisplayStatusKey } from '../lib/parcelStatus';
import { currentEvent } from '../lib/stages';
import type { ParcelWithEvents } from '../types';
import { ProgressTrack } from './ProgressTrack';

export function ParcelCard({
  parcel,
  onOpen,
  notice,
}: {
  parcel: ParcelWithEvents;
  onOpen: (parcel: ParcelWithEvents) => void;
  notice?: string;
}) {
  const { t } = useI18n();
  const carrier = carrierInfo(parcel.carrier);
  const current = currentEvent(parcel.events);
  const status = parcelDisplayStatus(parcel);
  const expectedDelivery = parcel.expectedDelivery
    ? localizedExpectedDelivery(parcel.expectedDelivery, t)
    : null;
  const statusLabel = t(parcelDisplayStatusKey(parcel));
  const parcelName = parcel.label || t('common.parcel');

  return (
    <button
      type="button"
      className={`parcel-card parcel-card--${status.tone}`}
      onClick={() => onOpen(parcel)}
      aria-label={expectedDelivery
        ? t('parcel.ariaExpected', { name: parcelName, status: statusLabel, date: expectedDelivery })
        : t('parcel.aria', { name: parcelName, status: statusLabel })}
    >
      <div className="parcel-card__stamp" aria-hidden="true">
        <svg viewBox="0 0 32 32">
          <path d="m6 10 10-5 10 5-10 5-10-5Z" />
          <path d="M6 10v12l10 5 10-5V10M16 15v12" />
        </svg>
      </div>
      <div className="parcel-card__body">
        <div className="parcel-card__top">
          <span className="parcel-card__carrier">{carrier.name}</span>
          <span className="parcel-card__time">
            {current ? localizedRelativeTime(current.occurredAt, t) : ''}
          </span>
        </div>
        <span className="parcel-card__label">{parcelName}</span>
        <span className="parcel-card__tracking">
          {formatTrackingNumber(parcel.trackingNumber)}
        </span>
        <div className="parcel-card__status">
          <span
            className={`status-badge status-badge--${status.tone}${status.syncing ? ' status-badge--syncing' : ''}`}
          >
            {statusLabel}
          </span>
        </div>
        {expectedDelivery && (
          <p className="parcel-card__eta">
            {t('parcel.expected', { date: expectedDelivery })}
          </p>
        )}
        {parcel.syncStatus === 'error' && (
          <p className="parcel-card__sync-error">{t('parcel.syncAttention')}</p>
        )}
        {notice && parcel.syncStatus !== 'error' && (
          <p className="parcel-card__notice">{notice}</p>
        )}
        <ProgressTrack stage={current?.stage ?? null} />
      </div>
      <div className="parcel-card__chevron" aria-hidden="true">
        <svg viewBox="0 0 20 20"><path d="m7 4 6 6-6 6" /></svg>
      </div>
    </button>
  );
}
