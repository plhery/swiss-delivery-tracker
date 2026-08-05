import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SignInScreen } from './SignInScreen';

describe('SignInScreen', () => {
  it('requests and verifies an emailed one-time code', async () => {
    const sendCode = vi.fn().mockResolvedValue(undefined);
    const verifyCode = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <SignInScreen configured sendCode={sendCode} verifyCode={verifyCode} />,
    );

    await user.type(screen.getByLabelText('Email address'), 'Owner@Example.Test');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(sendCode).toHaveBeenCalledWith('owner@example.test');

    const code = screen.getByLabelText('Sign-in code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await user.type(code, '12a 3456');
    await user.click(screen.getByRole('button', { name: 'Open my delivery box' }));
    expect(verifyCode).toHaveBeenCalledWith('owner@example.test', '123456');
  });

  it('keeps provider errors actionable', async () => {
    const sendCode = vi.fn().mockRejectedValue(new Error('Email rate limit reached'));
    const user = userEvent.setup();
    render(
      <SignInScreen configured sendCode={sendCode} verifyCode={vi.fn()} />,
    );
    await user.type(screen.getByLabelText('Email address'), 'owner@example.test');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email rate limit reached');
  });

  it('explains missing deployment configuration', () => {
    render(
      <SignInScreen configured={false} sendCode={vi.fn()} verifyCode={vi.fn()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'VITE_SUPABASE_PUBLISHABLE_KEY',
    );
  });
});
