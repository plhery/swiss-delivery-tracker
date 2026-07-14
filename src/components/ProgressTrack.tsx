import { CORE_STAGES, stageMeta } from '../lib/stages';
import type { Stage } from '../types';

/**
 * Five little steps from "announced" to "delivered", filled up to the
 * parcel's current position.
 */
export function ProgressTrack({ stage }: { stage: Stage | null }) {
  const meta = stage ? stageMeta(stage) : null;
  const position = meta?.progress ?? -1;
  const label = meta
    ? `Step ${position + 1} of ${CORE_STAGES.length}: ${meta.label}`
    : 'No tracking events yet';

  return (
    <div
      className={`progress-track${meta ? ` progress-track--${meta.tone}` : ''}`}
      role="img"
      aria-label={label}
    >
      {CORE_STAGES.map((coreStage, i) => (
        <span
          key={coreStage}
          className={`progress-track__dot${
            i <= position ? ' progress-track__dot--filled' : ''
          }${i === position ? ' progress-track__dot--current' : ''}`}
        />
      ))}
    </div>
  );
}
