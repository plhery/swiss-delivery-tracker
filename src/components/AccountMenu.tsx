export function AccountMenu({
  email,
  onSignOut,
}: {
  email: string;
  onSignOut: () => Promise<void>;
}) {
  const initial = email.trim().charAt(0).toUpperCase() || '?';
  return (
    <details className="account-menu">
      <summary aria-label={`Account options for ${email}`}>{initial}</summary>
      <div className="account-menu__popover">
        <span>Signed in as</span>
        <strong>{email}</strong>
        <button type="button" onClick={() => void onSignOut()}>Sign out</button>
      </div>
    </details>
  );
}
