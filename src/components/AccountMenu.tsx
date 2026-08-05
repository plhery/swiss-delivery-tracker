import { useState } from 'react';

type AccountAction = 'export' | 'delete' | 'sign-out';

export function AccountMenu({
  email,
  onExport,
  onDelete,
  onSignOut,
}: {
  email: string;
  onExport?: () => Promise<void>;
  onDelete?: (confirmation: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const initial = email.trim().charAt(0).toUpperCase() || '?';
  const [working, setWorking] = useState<AccountAction | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function run(action: AccountAction, operation: () => Promise<void>) {
    if (working) return;
    setWorking(action);
    setError(null);
    try {
      await operation();
      if (action === 'export') setWorking(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not ${action}`);
      setWorking(null);
    }
  }

  return (
    <details className="account-menu">
      <summary aria-label={`Account options for ${email}`}>{initial}</summary>
      <div className="account-menu__popover">
        <span>Signed in as</span>
        <strong>{email}</strong>
        {error && <span className="account-menu__error" role="alert">{error}</span>}

        {confirmingDelete ? (
          <div className="account-menu__delete-confirmation">
            <strong>Delete this account permanently?</strong>
            <span>All parcels, tracking history, and notification settings will be erased.</span>
            <label htmlFor="delete-account-confirmation">Type {email} to confirm</label>
            <input
              id="delete-account-confirmation"
              type="email"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoFocus
            />
            <button
              className="account-menu__danger"
              type="button"
              disabled={
                Boolean(working)
                || confirmation.trim().toLowerCase() !== email.toLowerCase()
              }
              onClick={() => void run(
                'delete',
                () => onDelete?.(confirmation) ?? Promise.resolve(),
              )}
            >
              {working === 'delete' ? 'Deleting…' : 'Permanently delete'}
            </button>
            <button
              type="button"
              disabled={Boolean(working)}
              onClick={() => {
                setConfirmingDelete(false);
                setConfirmation('');
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            {onExport && (
              <button
                type="button"
                disabled={Boolean(working)}
                onClick={() => void run('export', onExport)}
              >
                {working === 'export' ? 'Preparing export…' : 'Download my data'}
              </button>
            )}
            <button
              type="button"
              disabled={Boolean(working)}
              onClick={() => void run('sign-out', onSignOut)}
            >
              {working === 'sign-out' ? 'Signing out…' : 'Sign out'}
            </button>
            <a className="account-menu__privacy" href="/privacy.html">
              Privacy notice
            </a>
            {onDelete && (
              <button
                className="account-menu__danger"
                type="button"
                disabled={Boolean(working)}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete account
              </button>
            )}
          </>
        )}
      </div>
    </details>
  );
}
