import unittest
from io import BytesIO
from types import ModuleType, SimpleNamespace

from server.bounded_http import (
    BoundedResponse,
    UpstreamResponseTooLarge,
    install_bounded_http,
)


class ContextResponse(BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False


class BoundedHttpTests(unittest.TestCase):
    def test_unbounded_read_stops_after_the_configured_limit(self):
        response = BoundedResponse(ContextResponse(b"four"), limit=3)

        with self.assertRaisesRegex(UpstreamResponseTooLarge, "unexpectedly large"):
            response.read()

    def test_limit_is_cumulative_across_streamed_reads(self):
        response = BoundedResponse(ContextResponse(b"four"), limit=3)

        self.assertEqual(response.read(2), b"fo")
        self.assertEqual(response.read(1), b"u")
        with self.assertRaises(UpstreamResponseTooLarge):
            response.read(1)

    def test_carrier_module_receives_a_private_bounded_urllib_proxy(self):
        raw_response = ContextResponse(b"too large")
        request_module = SimpleNamespace(urlopen=lambda *args, **kwargs: raw_response)
        carrier = ModuleType("carrier")
        carrier.urllib = SimpleNamespace(request=request_module)

        install_bounded_http(carrier, limit=3)

        with self.assertRaises(UpstreamResponseTooLarge):
            carrier.urllib.request.urlopen("https://carrier.invalid").read()

    def test_http_client_connections_receive_the_same_response_limit(self):
        connection = SimpleNamespace(
            getresponse=lambda: ContextResponse(b"too large")
        )
        client_module = SimpleNamespace(HTTPSConnection=lambda *args, **kwargs: connection)
        carrier = ModuleType("carrier")
        carrier.http = SimpleNamespace(client=client_module)

        install_bounded_http(carrier, limit=3)

        bounded_connection = carrier.http.client.HTTPSConnection("carrier.invalid")
        with self.assertRaises(UpstreamResponseTooLarge):
            bounded_connection.getresponse().read()


if __name__ == "__main__":
    unittest.main()
