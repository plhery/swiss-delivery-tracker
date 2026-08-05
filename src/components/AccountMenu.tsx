import { useState } from 'react';
import { useI18n } from '../i18n';

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
  const { t } = useI18n();
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
      setError(reason instanceof Error ? reason.message : t('account.actionFailed'));
      setWorking(null);
    }
  }

  return (
    <details className="account-menu">
      <summary aria-label={t('account.options', { email })}>{initial}</summary>
      <div className="account-menu__popover">
        <span>{t('account.signedIn')}</span>
        <strong>{email}</strong>
        {error && <span className="account-menu__error" role="alert">{error}</span>}

        {confirmingDelete ? (
          <div className="account-menu__delete-confirmation">
            <strong>{t('account.deleteQuestion')}</strong>
            <span>{t('account.deleteDescription')}</span>
            <label htmlFor="delete-account-confirmation">
              {t('account.typeToConfirm', { email })}
            </label>
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
              {working === 'delete' ? t('account.deleting') : t('account.deletePermanent')}
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
              {t('common.cancel')}
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
                {working === 'export' ? t('account.exporting') : t('account.export')}
              </button>
            )}
            <button
              type="button"
              disabled={Boolean(working)}
              onClick={() => void run('sign-out', onSignOut)}
            >
              {working === 'sign-out' ? t('account.signingOut') : t('account.signOut')}
            </button>
            <a className="account-menu__privacy" href="/privacy.html">
              {t('account.privacy')}
            </a>
            {onDelete && (
              <button
                className="account-menu__danger"
                type="button"
                disabled={Boolean(working)}
                onClick={() => setConfirmingDelete(true)}
              >
                {t('account.delete')}
              </button>
            )}
          </>
        )}
      </div>
    </details>
  );
}
