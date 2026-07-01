import { formatDateTime } from '../lib/format';
import { sortEventsDesc, stageMeta } from '../lib/stages';
import type { TrackingEvent } from '../types';

/** The parcel's journey, newest update on top. */
export function Timeline({ events }: { events: TrackingEvent[] }) {
  const sorted = sortEventsDesc(events);

  if (sorted.length === 0) {
    return (
      <p className="timeline-empty">
        No tracking events yet — check back soon! 🕊️
      </p>
    );
  }

  return (
    <ol className="timeline" aria-label="Tracking history">
      {sorted.map((event, i) => {
        const meta = stageMeta(event.stage);
        return (
          <li
            key={event.id}
            className={`timeline__item${i === 0 ? ' timeline__item--latest' : ''}`}
          >
            <span
              className={`timeline__dot timeline__dot--${meta.tone}`}
              aria-hidden="true"
            >
              {meta.emoji}
            </span>
            <div className="timeline__content">
              <div className="timeline__stage">{meta.label}</div>
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
