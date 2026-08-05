import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  detectLocale,
  I18nProvider,
  LanguageControl,
  stageLabel,
  useI18n,
} from './i18n';

function TranslationProbe() {
  const { t } = useI18n();
  return <p>{stageLabel(t, 'out_for_delivery')}</p>;
}

describe('localization', () => {
  it('detects all supported Swiss languages and falls back to English', () => {
    expect(detectLocale(['de-CH'])).toBe('de');
    expect(detectLocale(['rm-CH', 'it-CH'])).toBe('it');
    expect(detectLocale(['es-ES'])).toBe('en');
  });

  it('persists an explicit language and updates the document language', async () => {
    window.localStorage.setItem('deliveryTrackerLocale', 'de');
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <LanguageControl />
        <TranslationProbe />
      </I18nProvider>,
    );

    expect(screen.getByLabelText('Sprache')).toHaveValue('de');
    expect(screen.getByText('In Zustellung')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Sprache'), 'fr');
    expect(screen.getByText('En livraison')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('fr');
      expect(window.localStorage.getItem('deliveryTrackerLocale')).toBe('fr');
    });
  });
});
