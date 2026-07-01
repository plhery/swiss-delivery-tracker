import { carrierInfo, formatTrackingNumber } from '../lib/carriers';
import { latestEvent, stageMeta } from '../lib/stages';
import type { ParcelWithEvents } from '../types';
import { ProgressTrack } from './ProgressTrack';
import { Timeline } from './Timeline';

export function ParcelDetail({
  parcel,
  onBack,
  onDelete,
}: {
  parcel: ParcelWithEvents;
  onBack: () => void;
  onDelete: (parcel: ParcelWithEvents) => void;
}) {
  const carrier = carrierInfo(parcel.carrier);
  const last = latestEvent(parcel.events);
  const meta = last ? stageMeta(last.stage) : null;
  const trackingUrl = carrier.trackingUrl?.(parcel.trackingNumber);

  return (
    <div className="detail" role="dialog" aria-label={parcel.label || 'Parcel'}>
      <header className="detail__header">
        <button type="button" className="detail__back" onClick={onBack}>
          ‹ Back
        </button>
      </header>

      <div className="detail__hero">
        <div className="detail__emoji" aria-hidden="true">
          {meta?.emoji ?? '📦'}
        </div>
        <h1 className="detail__title">{parcel.label || 'Parcel'}</h1>
        <p className="detail__status">
          <span className={`status-badge status-badge--${meta?.tone ?? 'ok'}`}>
            {meta?.label ?? 'Waiting for updates'}
          </span>
        </p>
        <ProgressTrack stage={last?.stage ?? null} />
        <p className="detail__tracking">
          {carrier.name} · {formatTrackingNumber(parcel.trackingNumber)}
        </p>
        {trackingUrl && (
          <a
            className="detail__carrier-link"
            href={trackingUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open on {carrier.name} ↗
          </a>
        )}
      </div>

      <section className="detail__timeline">
        <h2 className="detail__section-title">Journey</h2>
        <Timeline events={parcel.events} />
      </section>

      <footer className="detail__footer">
        <button
          type="button"
          className="button button--danger"
          onClick={() => onDelete(parcel)}
        >
          Remove parcel
        </button>
      </footer>
    </div>
  );
}
