import unittest
from unittest.mock import Mock, patch

from jwt.exceptions import InvalidTokenError

from server.cloudflare_access import AccessValidationError, CloudflareAccessValidator


class CloudflareAccessValidatorTests(unittest.TestCase):
    def setUp(self):
        self.signing_key = Mock(key="public-key")
        self.jwk_client = Mock()
        self.jwk_client.get_signing_key_from_jwt.return_value = self.signing_key
        self.validator = CloudflareAccessValidator(
            "team.cloudflareaccess.com/",
            "application-audience",
            jwk_client=self.jwk_client,
        )

    def test_validates_signature_issuer_audience_and_application_type(self):
        with patch(
            "server.cloudflare_access.jwt.decode",
            return_value={"type": "app", "sub": "user@example.test"},
        ) as decode:
            claims = self.validator.validate("signed-token")

        self.assertEqual(claims["sub"], "user@example.test")
        self.jwk_client.get_signing_key_from_jwt.assert_called_once_with("signed-token")
        decode.assert_called_once_with(
            "signed-token",
            "public-key",
            algorithms=["RS256"],
            audience="application-audience",
            issuer="https://team.cloudflareaccess.com",
        )

    def test_rejects_missing_invalid_and_non_application_tokens(self):
        with self.assertRaises(AccessValidationError):
            self.validator.validate(None)

        with patch(
            "server.cloudflare_access.jwt.decode",
            side_effect=InvalidTokenError("expired"),
        ):
            with self.assertRaises(AccessValidationError):
                self.validator.validate("expired-token")

        with patch("server.cloudflare_access.jwt.decode", return_value={"type": "org"}):
            with self.assertRaises(AccessValidationError):
                self.validator.validate("organization-token")


if __name__ == "__main__":
    unittest.main()
