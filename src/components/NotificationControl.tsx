import { useEffect, useState } from 'react';
import {
  disablePushNotifications,
  enablePushNotifications,
  inspectPushState,
  type PushState,
} from '../lib/pushNotifications';

export function NotificationControl() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = state?.kind === 'enabled';

  useEffect(() => {
    void inspectPushState().then(setState).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Notification settings are unavailable');
    });
  }, []);

  async function enable() {
    if (!state || state.kind !== 'prompt') return;
    setBusy(true);
    setError(null);
    try {
      const testSent = await enablePushNotifications(state.publicKey);
      setState({ kind: 'enabled', publicKey: state.publicKey });
      if (!testSent) setError('Enabled. The welcome alert could not be sent, but updates will retry.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not enable notifications');
      setState(await inspectPushState());
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await disablePushNotifications();
      const next = await inspectPushState();
      setState(next.kind === 'enabled' ? { kind: 'prompt', publicKey: next.publicKey } : next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not disable notifications');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`icon-button notification-button${enabled ? ' notification-button--enabled' : ''}`}
        aria-label={enabled ? 'Notifications enabled' : 'Notification settings'}
        onClick={() => setOpen(true)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
      </button>

      {open && (
        <div className="sheet-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section
            className="sheet notification-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notifications-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="sheet__grabber" />
            <div className="sheet__heading">
              <div>
                <p className="sheet__eyebrow">Parcel alerts</p>
                <h2 className="sheet__title" id="notifications-title">Notifications</h2>
              </div>
              <button className="sheet__close" type="button" aria-label="Close" onClick={() => setOpen(false)}>×</button>
            </div>

            <div className={`notification-status${enabled ? ' notification-status--enabled' : ''}`}>
              <span className="notification-status__mark" aria-hidden="true" />
              <div>
                <strong>{enabled ? 'Updates will find you' : 'Get parcel progress on your phone'}</strong>
                <p>{copyFor(state, Boolean(error))}</p>
              </div>
            </div>

            <p className="notification-schedule">
              Tracking checks run every 10 minutes from 08:00 to 22:00, then hourly overnight.
            </p>
            {error && <p className="sheet__error" role="alert">{error}</p>}

            {state?.kind === 'prompt' && (
              <button className="button button--primary notification-action" type="button" disabled={busy} onClick={() => void enable()}>
                {busy ? 'Enabling…' : 'Enable notifications'}
              </button>
            )}
            {enabled && (
              <button className="button button--secondary notification-action" type="button" disabled={busy} onClick={() => void disable()}>
                {busy ? 'Turning off…' : 'Turn off on this device'}
              </button>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function copyFor(state: PushState | null, hasError: boolean): string {
  if (hasError) return 'Open these settings again to retry.';
  switch (state?.kind) {
    case 'enabled': return 'This device is subscribed to new tracking events.';
    case 'unsupported': return 'On iPhone, add Parcel Post to your Home Screen, then open it there.';
    case 'unavailable': return 'The notification service is not configured yet.';
    case 'blocked': return 'Notifications are blocked. Allow them in this app’s system settings.';
    case 'prompt': return 'Enable alerts once on every device where you want to receive them.';
    default: return 'Checking this device…';
  }
}
