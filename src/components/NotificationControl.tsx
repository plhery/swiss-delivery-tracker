import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ALL_NOTIFICATION_STAGES,
  DELIVERY_DAY_NOTIFICATION_STAGES,
  disablePushNotifications,
  enablePushNotifications,
  getNotificationPreferences,
  IMPORTANT_NOTIFICATION_STAGES,
  inspectPushState,
  saveNotificationPreferences,
  type NotificationPreferences,
  type NotificationStage,
  type PushState,
} from '../lib/pushNotifications';
import type { ApiAuth } from '../lib/apiClient';
import { useModalDialog } from '../lib/modal';
import { type Translate, useI18n } from '../i18n';

type EventPreset = 'all' | 'important' | 'delivery-day';

const PRESET_STAGES: Record<EventPreset, NotificationStage[]> = {
  all: ALL_NOTIFICATION_STAGES,
  important: IMPORTANT_NOTIFICATION_STAGES,
  'delivery-day': DELIVERY_DAY_NOTIFICATION_STAGES,
};

export function NotificationControl({ apiAuth }: { apiAuth?: ApiAuth }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [preset, setPreset] = useState<EventPreset>('all');
  const [quietHours, setQuietHours] = useState(false);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('08:00');
  const [preferencesBusy, setPreferencesBusy] = useState(false);
  const [preferencesNotice, setPreferencesNotice] = useState<string | null>(null);
  const enabled = state?.kind === 'enabled';
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useModalDialog<HTMLElement>(open, () => setOpen(false), closeButton);

  useEffect(() => {
    void inspectPushState(apiAuth).then(setState).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : t('notifications.error.unavailable'));
    });
  }, [apiAuth, t]);

  useEffect(() => {
    if (!apiAuth) return;
    void getNotificationPreferences(apiAuth).then((next) => {
      setPreferences(next);
      setPreset(presetFor(next.enabledStages));
      setQuietHours(Boolean(next.quietHoursStart && next.quietHoursEnd));
      setQuietStart(next.quietHoursStart ?? '22:00');
      setQuietEnd(next.quietHoursEnd ?? '08:00');
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : t('notifications.error.preferences'));
    });
  }, [apiAuth, t]);

  async function enable() {
    if (!state || state.kind !== 'prompt') return;
    setBusy(true);
    setError(null);
    try {
      const testSent = await enablePushNotifications(state.publicKey, apiAuth);
      setState({ kind: 'enabled', publicKey: state.publicKey });
      if (!testSent) setError(t('notifications.error.welcome'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('notifications.error.enable'));
      setState(await inspectPushState(apiAuth));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await disablePushNotifications(apiAuth);
      const next = await inspectPushState(apiAuth);
      setState(next.kind === 'enabled' ? { kind: 'prompt', publicKey: next.publicKey } : next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('notifications.error.disable'));
    } finally {
      setBusy(false);
    }
  }

  async function savePreferences() {
    if (!apiAuth || preferencesBusy) return;
    setPreferencesBusy(true);
    setPreferencesNotice(null);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
        || preferences?.timezone
        || 'Europe/Zurich';
      const saved = await saveNotificationPreferences({
        enabledStages: PRESET_STAGES[preset],
        quietHoursStart: quietHours ? quietStart : null,
        quietHoursEnd: quietHours ? quietEnd : null,
        timezone,
      }, apiAuth);
      setPreferences(saved);
      setPreferencesNotice(t('notifications.saved'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('notifications.error.save'));
    } finally {
      setPreferencesBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`icon-button notification-button${enabled ? ' notification-button--enabled' : ''}`}
        aria-label={enabled ? t('notifications.enabledButton') : t('notifications.button')}
        onClick={() => setOpen(true)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
      </button>

      {open && createPortal(
        <div className="sheet-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section
            ref={dialog}
            className="sheet notification-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notifications-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="sheet__grabber" />
            <div className="sheet__heading">
              <div>
                <p className="sheet__eyebrow">{t('notifications.eyebrow')}</p>
                <h2 className="sheet__title" id="notifications-title">{t('notifications.title')}</h2>
              </div>
              <button ref={closeButton} className="sheet__close" type="button" aria-label={t('common.close')} onClick={() => setOpen(false)}>×</button>
            </div>

            <div className={`notification-status${enabled ? ' notification-status--enabled' : ''}`}>
              <span className="notification-status__mark" aria-hidden="true" />
              <div>
                <strong>{enabled ? t('notifications.enabledTitle') : t('notifications.disabledTitle')}</strong>
                <p>{copyFor(state, Boolean(error), t)}</p>
              </div>
            </div>

            <p className="notification-schedule">
              {t('notifications.schedule')}
            </p>
            {error && <p className="sheet__error" role="alert">{error}</p>}

            {apiAuth && preferences && (
              <div className="notification-preferences">
                <fieldset>
                  <legend>{t('notifications.preferencesTitle')}</legend>
                  <PreferenceOption
                    value="all"
                    selected={preset}
                    onChange={setPreset}
                    title={t('notifications.preset.all')}
                    description={t('notifications.preset.allDescription')}
                  />
                  <PreferenceOption
                    value="important"
                    selected={preset}
                    onChange={setPreset}
                    title={t('notifications.preset.important')}
                    description={t('notifications.preset.importantDescription')}
                  />
                  <PreferenceOption
                    value="delivery-day"
                    selected={preset}
                    onChange={setPreset}
                    title={t('notifications.preset.deliveryDay')}
                    description={t('notifications.preset.deliveryDayDescription')}
                  />
                </fieldset>

                <label className="notification-preferences__quiet">
                  <input
                    type="checkbox"
                    checked={quietHours}
                    onChange={(event) => setQuietHours(event.target.checked)}
                  />
                  <span>
                    <strong>{t('notifications.quietHours')}</strong>
                    <small>{t('notifications.quietDescription')}</small>
                  </span>
                </label>
                {quietHours && (
                  <div className="notification-preferences__times">
                    <label>
                      <span>{t('notifications.from')}</span>
                      <input
                        type="time"
                        value={quietStart}
                        onChange={(event) => setQuietStart(event.target.value)}
                        required
                      />
                    </label>
                    <label>
                      <span>{t('notifications.until')}</span>
                      <input
                        type="time"
                        value={quietEnd}
                        onChange={(event) => setQuietEnd(event.target.value)}
                        required
                      />
                    </label>
                  </div>
                )}
                {preferencesNotice && (
                  <p className="notification-preferences__saved" role="status">
                    {preferencesNotice}
                  </p>
                )}
                <button
                  className="button button--primary notification-action"
                  type="button"
                  disabled={preferencesBusy || (quietHours && (!quietStart || !quietEnd))}
                  onClick={() => void savePreferences()}
                >
                  {preferencesBusy ? t('notifications.saving') : t('notifications.save')}
                </button>
              </div>
            )}

            {state?.kind === 'prompt' && (
              <button className="button button--primary notification-action" type="button" disabled={busy} onClick={() => void enable()}>
                {busy ? t('notifications.enabling') : t('notifications.enable')}
              </button>
            )}
            {enabled && (
              <button className="button button--secondary notification-action" type="button" disabled={busy} onClick={() => void disable()}>
                {busy ? t('notifications.disabling') : t('notifications.disable')}
              </button>
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

function sameStages(left: readonly NotificationStage[], right: readonly NotificationStage[]) {
  return left.length === right.length && left.every((stage) => right.includes(stage));
}

function presetFor(stages: readonly NotificationStage[]): EventPreset {
  if (sameStages(stages, DELIVERY_DAY_NOTIFICATION_STAGES)) return 'delivery-day';
  if (sameStages(stages, IMPORTANT_NOTIFICATION_STAGES)) return 'important';
  return 'all';
}

function PreferenceOption({
  value,
  selected,
  onChange,
  title,
  description,
}: {
  value: EventPreset;
  selected: EventPreset;
  onChange: (value: EventPreset) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="notification-preferences__option">
      <input
        type="radio"
        name="notification-preset"
        value={value}
        checked={selected === value}
        onChange={() => onChange(value)}
      />
      <span><strong>{title}</strong><small>{description}</small></span>
    </label>
  );
}

function copyFor(state: PushState | null, hasError: boolean, t: Translate): string {
  if (hasError) return t('notifications.state.retry');
  switch (state?.kind) {
    case 'enabled': return t('notifications.state.enabled');
    case 'unsupported': return t('notifications.state.unsupported');
    case 'unavailable': return t('notifications.state.unavailable');
    case 'blocked': return t('notifications.state.blocked');
    case 'prompt': return t('notifications.state.prompt');
    default: return t('notifications.state.checking');
  }
}
