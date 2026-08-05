import base64
import json
import unittest
import urllib.error
from datetime import datetime, timezone
from io import BytesIO
from unittest.mock import patch

from server.supabase_auth import SupabaseAuthenticator, SupabaseAuthError

USER_ID = "10000000-0000-0000-0000-000000000001"
SESSION_ID = "30000000-0000-0000-0000-000000000003"


def token_with_claims(claims):
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    return f"{encode({'alg': 'test'})}.{encode(claims)}.signature"


class Response:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self.body


class SupabaseAuthenticatorTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.auth = SupabaseAuthenticator(
            "https://supabase.example.test/",
            "publishable-key",
            timeout=7,
            cache_seconds=60,
            clock=lambda: self.now,
        )

    @patch("server.supabase_auth.urllib.request.urlopen")
    def test_validates_with_auth_server_and_builds_user_client(self, urlopen):
        token = token_with_claims(
            {
                "sub": USER_ID,
                "session_id": SESSION_ID,
                "amr": [
                    {"method": "otp", "timestamp": 1_775_550_600},
                    {"method": "token_refresh", "timestamp": 1_775_554_200},
                ],
            }
        )
        urlopen.return_value = Response(
            {
                "id": USER_ID,
                "email": "owner@example.test",
                "last_sign_in_at": "2026-08-05T08:30:00Z",
            }
        )

        user = self.auth.validate(token)

        self.assertEqual(user.id, USER_ID)
        self.assertEqual(user.email, "owner@example.test")
        self.assertEqual(
            user.authenticated_at,
            datetime.fromtimestamp(1_775_550_600, timezone.utc),
        )
        self.assertEqual(user.session_id, SESSION_ID)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://supabase.example.test/auth/v1/user")
        self.assertEqual(request.get_header("Apikey"), "publishable-key")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {token}")
        urlopen.assert_called_once_with(request, timeout=7)

        client = self.auth.user_client(token)
        self.assertEqual(client.api_key, "publishable-key")
        self.assertEqual(client.access_token, token)

    @patch("server.supabase_auth.urllib.request.urlopen")
    def test_caches_success_briefly_without_storing_raw_token_as_key(self, urlopen):
        urlopen.return_value = Response(
            {"id": "10000000-0000-0000-0000-000000000001"}
        )

        first = self.auth.validate("signed-access-token")
        self.now += 59
        second = self.auth.validate("signed-access-token")
        self.assertIs(first, second)
        urlopen.assert_called_once()
        self.assertNotIn("signed-access-token", self.auth._cache)

        self.now += 2
        self.auth.validate("signed-access-token")
        self.assertEqual(urlopen.call_count, 2)

        self.auth.validate("signed-access-token", use_cache=False)
        self.assertEqual(urlopen.call_count, 3)

    @patch("server.supabase_auth.urllib.request.urlopen")
    def test_rejects_missing_expired_and_malformed_users(self, urlopen):
        with self.assertRaises(SupabaseAuthError):
            self.auth.validate(None)

        expired = urllib.error.HTTPError(
            "https://supabase.example.test/auth/v1/user",
            401,
            "Unauthorized",
            {},
            BytesIO(b'{"message":"expired"}'),
        )
        self.addCleanup(expired.close)
        urlopen.side_effect = expired
        with self.assertRaises(SupabaseAuthError):
            self.auth.validate("expired-token")

        urlopen.side_effect = None
        urlopen.return_value = Response({"id": "not-a-uuid"})
        with self.assertRaises(SupabaseAuthError):
            self.auth.validate("malformed-user-token")

        urlopen.return_value = Response(
            {
                "id": "10000000-0000-0000-0000-000000000001",
                "is_anonymous": True,
            }
        )
        with self.assertRaises(SupabaseAuthError):
            self.auth.validate("anonymous-user-token")

    @patch("server.supabase_auth.urllib.request.urlopen")
    def test_account_global_last_sign_in_and_malformed_claims_are_not_recent_auth(self, urlopen):
        urlopen.return_value = Response(
            {
                "id": "10000000-0000-0000-0000-000000000001",
                "last_sign_in_at": "not-a-timestamp",
            }
        )

        user = self.auth.validate("signed-access-token")
        self.assertIsNone(user.authenticated_at)
        self.assertIsNone(user.session_id)

    @patch("server.supabase_auth.urllib.request.urlopen")
    def test_rejects_session_claims_for_a_different_user(self, urlopen):
        urlopen.return_value = Response({"id": USER_ID})
        token = token_with_claims(
            {
                "sub": "20000000-0000-0000-0000-000000000002",
                "session_id": SESSION_ID,
                "amr": [{"method": "oauth", "timestamp": 1_775_550_600}],
            }
        )

        user = self.auth.validate(token)

        self.assertIsNone(user.authenticated_at)
        self.assertIsNone(user.session_id)


if __name__ == "__main__":
    unittest.main()
