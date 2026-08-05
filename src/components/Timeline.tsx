import { formatDateTime } from '../lib/format';
import { currentEvent, sortEventsDesc, stageMeta } from '../lib/stages';
import type { TrackingEvent } from '../types';

/** The parcel's journey, newest update on top. */
export function Timeline({
  events,
  syncing = false,
}: {
  events: TrackingEvent[];
  syncing?: boolean;
}) {
  const sorted = sortEventsDesc(events);
  const current = currentEvent(events);

  if (sorted.length === 0) {
    return (
      <p className="timeline-empty">
        {syncing
          ? 'Checking with the carrier now…'
          : 'The carrier hasn’t announced this shipment yet — check back soon! 🕊️'}
      </p>
    );
  }

  return (
    <ol className="timeline" aria-label="Tracking history">
      {sorted.map((event) => {
        const meta = stageMeta(event.stage);
        const isCurrent = event.id === current?.id;
        return (
          <li
            key={event.id}
            className={`timeline__item${isCurrent ? ' timeline__item--latest' : ''}`}
          >
            <span
              className={`timeline__dot timeline__dot--${meta.tone}`}
              aria-hidden="true"
            />
            <div className="timeline__content">
              <div className="timeline__stage">
                {syncing && isCurrent && event.stage === 'pending'
                  ? 'Sync in progress'
                  : meta.label}
              </div>
              <div className="timeline__description">{event.description}</div>
              <div className="timeline__meta">
                {event.location ? `${event.location} · ` : ''}
                {formatDateTime(event.occurredAt)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
