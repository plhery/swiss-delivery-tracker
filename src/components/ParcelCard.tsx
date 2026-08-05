import { carrierInfo, formatTrackingNumber } from '../lib/carriers';
import { formatExpectedDelivery, relativeTime } from '../lib/format';
import { parcelDisplayStatus } from '../lib/parcelStatus';
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
  const carrier = carrierInfo(parcel.carrier);
  const current = currentEvent(parcel.events);
  const status = parcelDisplayStatus(parcel);
  const expectedDelivery = parcel.expectedDelivery
    ? formatExpectedDelivery(parcel.expectedDelivery)
    : null;

  return (
    <button
      type="button"
      className={`parcel-card parcel-card--${status.tone}`}
      onClick={() => onOpen(parcel)}
      aria-label={`${parcel.label || 'Parcel'} — ${status.label}${expectedDelivery ? ` — expected ${expectedDelivery}` : ''}`}
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
            {current ? relativeTime(current.occurredAt) : ''}
          </span>
        </div>
        <span className="parcel-card__label">{parcel.label || 'Parcel'}</span>
        <span className="parcel-card__tracking">
          {formatTrackingNumber(parcel.trackingNumber)}
        </span>
        <div className="parcel-card__status">
          <span
            className={`status-badge status-badge--${status.tone}${status.syncing ? ' status-badge--syncing' : ''}`}
          >
            {status.label}
          </span>
        </div>
        {expectedDelivery && (
          <p className="parcel-card__eta">
            Expected {expectedDelivery}
          </p>
        )}
        {parcel.syncStatus === 'error' && (
          <p className="parcel-card__sync-error">Sync needs attention</p>
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
