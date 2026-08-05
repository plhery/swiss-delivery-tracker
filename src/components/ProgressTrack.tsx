import { CORE_STAGES, stageMeta } from '../lib/stages';
import { stageLabel, useI18n } from '../i18n';
import type { Stage } from '../types';

/**
 * Six little steps from "tracked" to "delivered", filled up to the
 * parcel's current position.
 */
export function ProgressTrack({ stage }: { stage: Stage | null }) {
  const { t } = useI18n();
  const meta = stage ? stageMeta(stage) : null;
  const position = meta?.progress ?? -1;
  const label = meta
    ? t('progress.step', {
      step: position + 1,
      total: CORE_STAGES.length,
      stage: stageLabel(t, stage!),
    })
    : t('progress.empty');

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
