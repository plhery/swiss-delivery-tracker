import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GeodisTrackingError,
  GeodisTracker,
  geodisRequestBody,
  geodisServiceHeader,
  geodisTrackingUrl,
  normalizeGeodisTrackingNumber,
  parseGeodisTrackingResponse,
} from './geodis';

const OFFICIAL_SYNTHETIC_NUMBER = '1G123GEODIS0';

function successPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    codeErreur: null,
    texteErreur: null,
    contenu: {
      noSuivi: OFFICIAL_SYNTHETIC_NUMBER,
      etatLivre: false,
      etatRetire: false,
      finDeVie: false,
      timeline: {
        positionCourante: 3,
        listTimesteps: [
          { actif: false, position: 1, libelle: 'Enregistré' },
          { actif: true, position: 3, libelle: 'En cours de livraison' },
        ],
      },
      listJoursSuivis: [
        {
          dateSuivi: '29/08/2026',
          suivis: [{
            heureSuivi: '09:30:00',
            libelleCentre: 'AGENCE PARIS',
            libelleSuivi: 'En cours de livraison',
            listInformationsComplementaires: ['PRIVATE DELIVERY INSTRUCTION'],
            adresse: '10 PRIVATE STREET',
          }],
        },
        {
          dateSuivi: '28/08/2026',
          suivis: [{
            heureSuivi: '14:05:00',
            libelleCentre: 'CENTRE DE TRI',
            libelleSuivi: 'Envoi pris en charge',
          }],
        },
      ],
      expediteur: { nom: 'PRIVATE SENDER', adresse1: 'PRIVATE ORIGIN' },
      destinataire: { nom: 'PRIVATE RECIPIENT', adresse1: 'PRIVATE DESTINATION' },
      listImagesBordereauxLivr: [{ url: 'https://private.example/document' }],
      dateLivraisonPrevue: '30/08/2026',
      ...overrides,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('GEODIS anonymous tracking request', () => {
  it('accepts only the official 12-character 1G form', () => {
    expect(normalizeGeodisTrackingNumber(` ${OFFICIAL_SYNTHETIC_NUMBER.toLowerCase()} `))
      .toBe(OFFICIAL_SYNTHETIC_NUMBER);
    for (const value of [
      '1GSHORT',
      '00104444125506',
      '2G123GEODIS0',
      '1G123GEODIS',
      '1G123GEODIS00',
      '1G123GEODISÉ',
      '1G123GEODIS0&admin=true',
    ]) {
      expect(() => normalizeGeodisTrackingNumber(value)).toThrow('start with 1G');
    }
  });

  it('exposes the fixed endpoint, exact JSON body, and deterministic SPA signature', () => {
    expect(geodisTrackingUrl()).toBe(
      'https://espace-client.geodis.com/services/api/destinataire/recherche-envoi-anonyme',
    );
    expect(geodisRequestBody(OFFICIAL_SYNTHETIC_NUMBER))
      .toBe('{"noSuivi":"1G123GEODIS0"}');
    expect(geodisServiceHeader(OFFICIAL_SYNTHETIC_NUMBER, 1_735_689_600_123)).toBe(
      '$DESTINATAIRE;1735689600123;fr;90458ae51b15e0a392ac1063f7d8ccdf6ae4c390a6d599e778b34adf9d1b07a6',
    );
    expect(() => geodisServiceHeader(OFFICIAL_SYNTHETIC_NUMBER, 0))
      .toThrow('positive integer');
  });
});

describe('GEODIS response normalization', () => {
  it('normalizes the allowlisted timeline and never retains private or complementary fields', () => {
    const result = parseGeodisTrackingResponse(successPayload(), OFFICIAL_SYNTHETIC_NUMBER);

    expect(result).toMatchObject({
      status: 'out_for_delivery',
      last_status_text: 'En cours de livraison',
      last_update: '29/08/2026 09:30:00',
      expected_delivery: '2026-08-30',
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        time: '29/08/2026 09:30:00',
        location: 'AGENCE PARIS',
        description: 'En cours de livraison',
        stage: 'out_for_delivery',
      },
      {
        time: '28/08/2026 14:05:00',
        location: 'CENTRE DE TRI',
        description: 'Envoi pris en charge',
        stage: 'in_transit',
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'PRIVATE DELIVERY INSTRUCTION',
      'PRIVATE STREET',
      'PRIVATE SENDER',
      'PRIVATE RECIPIENT',
      'PRIVATE DESTINATION',
      'private.example',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('maps explicit delivered, collected, pickup-ready, and terminal failure states defensively', () => {
    expect(parseGeodisTrackingResponse(successPayload({ etatLivre: true }), OFFICIAL_SYNTHETIC_NUMBER).status)
      .toBe('delivered');
    expect(parseGeodisTrackingResponse(successPayload({ etatLivre: true }), OFFICIAL_SYNTHETIC_NUMBER)
      .expected_delivery).toBeNull();
    expect(parseGeodisTrackingResponse(successPayload({ etatRetire: true }), OFFICIAL_SYNTHETIC_NUMBER).status)
      .toBe('delivered');
    expect(parseGeodisTrackingResponse(successPayload({
      timeline: { listTimesteps: [{ actif: true, libelle: 'Disponible pour retrait en agence' }] },
      listJoursSuivis: [],
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      last_status_text: 'Disponible pour retrait en agence',
    });
    expect(parseGeodisTrackingResponse(successPayload({
      finDeVie: true,
      timeline: { listTimesteps: [{ actif: true, libelle: 'Traitement terminé' }] },
      listJoursSuivis: [],
    }), OFFICIAL_SYNTHETIC_NUMBER).status).toBe('exception');
  });

  it('does not treat delivery-driver or future-delivery wording as delivered', () => {
    const eventPayload = (label: string) => successPayload({
      timeline: { listTimesteps: [] },
      listJoursSuivis: [{
        dateSuivi: '29/08/2026',
        suivis: [{ heureSuivi: '09:30:00', libelleSuivi: label }],
      }],
    });

    expect(parseGeodisTrackingResponse(
      eventPayload('En cours de livraison par le livreur'),
      OFFICIAL_SYNTHETIC_NUMBER,
    )).toMatchObject({
      status: 'out_for_delivery',
      events: [{ stage: 'out_for_delivery' }],
    });
    expect(parseGeodisTrackingResponse(
      eventPayload('Votre colis va être livré prochainement'),
      OFFICIAL_SYNTHETIC_NUMBER,
    )).toMatchObject({
      status: 'in_transit',
      events: [{ stage: 'in_transit' }],
    });
  });

  it('handles structured not-found without exposing the provider text', () => {
    let error: unknown;
    try {
      parseGeodisTrackingResponse({
        ok: false,
        codeErreur: 'err.envoi.non.trouve',
        texteErreur: 'Envoi privé non trouvé avec des détails internes',
        contenu: null,
      }, OFFICIAL_SYNTHETIC_NUMBER);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GeodisTrackingError);
    expect(error).toMatchObject({
      message: 'GEODIS could not locate the shipment',
      status: 404,
    });
    expect(JSON.stringify(error)).not.toContain('détails internes');
  });

  it('rejects mismatched and structurally invalid success responses', () => {
    expect(() => parseGeodisTrackingResponse(successPayload({ noSuivi: '1GABCDEFGHIJ' }),
      OFFICIAL_SYNTHETIC_NUMBER)).toThrow('different shipment');
    expect(() => parseGeodisTrackingResponse({ ok: true, contenu: null }, OFFICIAL_SYNTHETIC_NUMBER))
      .toThrow('incomplete tracking details');
    expect(() => parseGeodisTrackingResponse({ ok: 'true', contenu: {} }, OFFICIAL_SYNTHETIC_NUMBER))
      .toThrow('invalid tracking response');
  });
});

describe('GEODIS tracker', () => {
  it('sends the bounded signed anonymous request and parses its response', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(successPayload()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new GeodisTracker(1_000).fetch(OFFICIAL_SYNTHETIC_NUMBER))
      .resolves.toMatchObject({ status: 'out_for_delivery' });

    expect(fetcher.mock.calls[0]?.[0]).toBe(geodisTrackingUrl());
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: 'POST',
      body: geodisRequestBody(OFFICIAL_SYNTHETIC_NUMBER),
      cache: 'no-store',
      redirect: 'error',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('Origin')).toBe('https://espace-client.geodis.com');
    const signature = headers.get('X-GEODIS-Service') ?? '';
    const parts = signature.split(';');
    expect(parts).toHaveLength(4);
    expect(signature).toBe(geodisServiceHeader(OFFICIAL_SYNTHETIC_NUMBER, Number(parts[1])));
  });
});
