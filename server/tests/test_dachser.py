import json
import unittest
from unittest.mock import patch

from server.dachser import (
    DACHSER_API_PATH,
    DACHSER_HOST,
    DachserTracker,
    dachser_api_url,
    parse_tracking_response,
    validate_dachser_tracking_url,
)

TRACKING_NUMBER = "9010000001234"
TRACKING_URL = (
    "https://customeriberia.dachser.com/customerarea/utilidades/"
    "seguimiento-publico/detalle?cliente=generico"
    f"&numeroUnico={TRACKING_NUMBER}&fecha=20260513&clave=TESTKEY9"
    "&idioma=1&tipoMail=C"
)


def tracking_payload() -> dict:
    return {
        "numUnico": TRACKING_NUMBER,
        "estadoExpedicion": "ENTREGADA",
        "fechaEstado": "15/05/2026 14:30:00",
        "fCompromiso": "16/05/2026",
        "datosConsignatario": {
            "nombre": "Private Recipient",
            "email": "recipient@example.invalid",
            "direccion": "Private address",
        },
        "datosRemitente": {"nombre": "Private Sender"},
        "urlImagenAlbaran": "https://private.example.invalid/proof.jpg",
        "incidenciaExpedicionData": [
            {
                "fechaIncidencia": "15/05/2026 14:30:00",
                "descripcionIncidencia": "MERCANCIA ENTREGADA A PRIVATE RECIPIENT",
                "observacionesIncidencia": "recipient@example.invalid",
            },
            {
                "fechaIncidencia": "14/05/2026 09:00:00",
                "descripcionIncidencia": (
                    "CONFIRMACION EN LA FECHA DE ENTREGA recipient@example.invalid"
                ),
            },
        ],
    }


class FakeResponse:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, _limit=-1):
        return self.body


class DachserTests(unittest.TestCase):
    def test_validates_capability_url_and_builds_api_endpoint(self):
        self.assertEqual(
            validate_dachser_tracking_url(TRACKING_URL, TRACKING_NUMBER),
            TRACKING_URL,
        )
        api_url = dachser_api_url(TRACKING_URL, TRACKING_NUMBER)
        self.assertIn(DACHSER_API_PATH, api_url)
        self.assertIn(f"numeroUnico={TRACKING_NUMBER}", api_url)
        self.assertNotIn("/customerarea/", api_url)

    def test_accepts_hash_capabilities(self):
        url = (
            "https://customeriberia.dachser.com/customerarea/utilidades/"
            f"seguimiento-publico/detalle?numeroUnico={TRACKING_NUMBER}&hash=abc_DEF-123"
        )
        self.assertEqual(validate_dachser_tracking_url(url, TRACKING_NUMBER), url)

    def test_canonicalizes_the_origin_for_database_validation(self):
        mixed_case = TRACKING_URL.replace(DACHSER_HOST, DACHSER_HOST.upper())

        self.assertEqual(
            validate_dachser_tracking_url(mixed_case, TRACKING_NUMBER),
            TRACKING_URL,
        )

    def test_rejects_unsafe_incomplete_and_mismatched_urls(self):
        invalid = (
            TRACKING_URL.replace("customeriberia.dachser.com", "example.test"),
            TRACKING_URL.replace(
                "customeriberia.dachser.com", "customeriberia.dachser.com.evil.test"
            ),
            TRACKING_URL.replace("/detalle?", "/other?"),
            TRACKING_URL.replace(TRACKING_NUMBER, "9010000009999"),
            TRACKING_URL.replace("&fecha=20260513&clave=TESTKEY9", ""),
            TRACKING_URL + f"&numeroUnico={TRACKING_NUMBER}",
            TRACKING_URL + "&redirect=https://example.test",
            TRACKING_URL + "#fragment",
        )
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_dachser_tracking_url(url, TRACKING_NUMBER)

    def test_reduces_response_to_non_personal_tracking_fields(self):
        result = parse_tracking_response(tracking_payload(), TRACKING_NUMBER)

        self.assertEqual(result["status"], "delivered")
        self.assertEqual(result["last_status_text"], "Delivered")
        self.assertEqual(result["last_update"], "2026-05-15T14:30:00+02:00")
        self.assertIsNone(result["expected_delivery"])
        self.assertEqual(result["events"][0]["stage"], "delivered")
        self.assertEqual(result["events"][1]["description"], "Delivery appointment updated")

        serialized = json.dumps(result).casefold()
        for private_value in (
            "private recipient",
            "private sender",
            "recipient@example.invalid",
            "private address",
            "proof.jpg",
            "datosconsignatario",
        ):
            self.assertNotIn(private_value, serialized)

    def test_maps_failed_delivery_before_delivered_wording(self):
        payload = tracking_payload()
        payload["estadoExpedicion"] = "NO ENTREGADA - INCIDENCIA"
        payload["fechaEntregaAplazada"] = "17/05/2026"
        result = parse_tracking_response(payload, TRACKING_NUMBER)

        self.assertEqual(result["status"], "exception")
        self.assertEqual(result["expected_delivery"], "2026-05-17")

    def test_rejects_missing_or_mismatched_response_identity(self):
        for returned_number in (None, "9010000009999"):
            payload = tracking_payload()
            payload["numUnico"] = returned_number
            with self.subTest(returned_number=returned_number), self.assertRaises(ValueError):
                parse_tracking_response(payload, TRACKING_NUMBER)

    @patch("server.dachser.urllib.request.urlopen")
    def test_fetches_json_from_the_validated_endpoint(self, urlopen):
        urlopen.return_value = FakeResponse(json.dumps(tracking_payload()).encode())

        result = DachserTracker(timeout=7).fetch(TRACKING_NUMBER, TRACKING_URL)

        self.assertEqual(result["status"], "delivered")
        request = urlopen.call_args.args[0]
        self.assertIn(DACHSER_API_PATH, request.full_url)
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 7)

    @patch("server.dachser.urllib.request.urlopen")
    def test_rejects_invalid_or_oversized_responses(self, urlopen):
        urlopen.return_value = FakeResponse(b"not json")
        with self.assertRaisesRegex(ValueError, "invalid tracking response"):
            DachserTracker().fetch(TRACKING_NUMBER, TRACKING_URL)

        urlopen.return_value = FakeResponse(b"x" * 2_000_001)
        with self.assertRaisesRegex(RuntimeError, "unexpectedly large"):
            DachserTracker().fetch(TRACKING_NUMBER, TRACKING_URL)


if __name__ == "__main__":
    unittest.main()
