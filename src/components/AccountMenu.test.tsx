import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccountMenu } from './AccountMenu';

describe('AccountMenu', () => {
  it('shows the account and signs out once', async () => {
    const onSignOut = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AccountMenu email="owner@example.test" onSignOut={onSignOut} />);

    await user.click(screen.getByLabelText('Account options for owner@example.test'));
    expect(screen.getByText('owner@example.test')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy notice' }))
      .toHaveAttribute('href', '/privacy.html');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Signing out…' })).toBeDisabled();
  });

  it('keeps sign-out failures actionable', async () => {
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="owner@example.test"
        onSignOut={vi.fn().mockRejectedValue(new Error('Network unavailable'))}
      />,
    );

    await user.click(screen.getByLabelText('Account options for owner@example.test'));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });

  it('exports data and requires the account email before deletion', async () => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <AccountMenu
        email="owner@example.test"
        onExport={onExport}
        onDelete={onDelete}
        onSignOut={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText('Account options for owner@example.test'));
    await user.click(screen.getByRole('button', { name: 'Download my data' }));
    expect(onExport).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Delete account' }));
    const deleteButton = screen.getByRole('button', { name: 'Permanently delete' });
    expect(deleteButton).toBeDisabled();
    await user.type(screen.getByLabelText(/type owner@example.test/i), 'Owner@Example.Test');
    expect(deleteButton).toBeEnabled();
    await user.click(deleteButton);
    expect(onDelete).toHaveBeenCalledWith('Owner@Example.Test');
  });
});
