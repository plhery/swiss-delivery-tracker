# Authentication

Swiss Delivery Tracker supports Google OAuth and passwordless email one-time
passwords (OTP) through Supabase Auth. Supabase is the identity and session
provider. An SMTP provider is only the mail transport used by Supabase; it is
not a second login system. Both login methods produce the same account-owned
data boundary.

## Browser and server configuration

The production frontend must be built with:

```dotenv
VITE_SUPABASE_URL=https://supabase.example.com
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_example
VITE_AUTH_GOOGLE_ENABLED=true
VITE_AUTH_EMAIL_OTP_ENABLED=false
```

The server needs the matching private configuration:

```dotenv
SUPABASE_URL=https://supabase.example.com
SUPABASE_PUBLIC_URL=https://supabase.example.com
SUPABASE_PUBLISHABLE_KEY=sb_publishable_example
SUPABASE_SERVICE_ROLE_KEY=server-only-service-role-key
```

The URL and publishable key are safe to expose; RLS protects database rows. The
service-role key bypasses RLS and must never use a `VITE_` prefix or enter logs,
screenshots, frontend build arguments, or repository history.

## Email OTP setup

Enable the Email provider and permit email sign-ups in Supabase Auth. Set the
application Site URL to the production HTTPS origin and allow only legitimate
development and production redirect origins.

Customize the **Magic Link / OTP** email template so the message visibly
contains the six-digit code:

```html
<h2>Your Swiss Delivery Tracker sign-in code</h2>
<p>Enter this code in Swiss Delivery Tracker:</p>
<p><strong>{{ .Token }}</strong></p>
<p>If you did not request this code, you can ignore this email.</p>
```

The UI calls `signInWithOtp` and then `verifyOtp` with type `email`. It does not
consume a magic-link callback.

For hosted Supabase, edit Auth settings and templates in the Supabase dashboard.
For self-hosted Supabase, configure GoTrue's site URL, allowed redirect URLs,
SMTP settings, and mailer template values in the deployment environment; the
hosted dashboard template editor does not configure a self-hosted Auth server.

## SMTP is required for a public service

Supabase's hosted default sender is a testing aid: it is restricted to project
team addresses, heavily rate-limited, and has no delivery SLA. Configure a
custom SMTP service before opening sign-up to the public. Any SMTP-compatible
service works, including Resend, Postmark, Amazon SES, SendGrid, Brevo, or a
mail server you already operate.

Use a dedicated sender such as `no-reply@auth.example.com`, publish SPF, DKIM,
and DMARC records, disable link tracking, and keep SMTP credentials server-only.
Enable CAPTCHA and tune Supabase's email rate limits before promoting the app
widely; OTP endpoints can otherwise be abused to consume quota or harm sender
reputation.

## Google OAuth setup

Create a **Web application** client in Google Auth Platform. Add the application
origin, such as `https://delivery.example.com`, as an authorized JavaScript
origin and add the exact Supabase callback URL as an authorized redirect URI:

```text
https://supabase.example.com/auth/v1/callback
```

For self-hosted Supabase, pass the client credentials only to GoTrue:

```dotenv
GOTRUE_EXTERNAL_GOOGLE_ENABLED=true
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=google-client-id
GOTRUE_EXTERNAL_GOOGLE_SECRET=server-only-client-secret
GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI=https://supabase.example.com/auth/v1/callback
```

Set `GOTRUE_SITE_URL` and `GOTRUE_URI_ALLOW_LIST` to the application origin,
restart the Auth service, and verify `/auth/v1/settings` reports Google as
enabled. The Google client secret never belongs in the Swiss Delivery Tracker
container or browser bundle.

## Session duration

The browser client persists the Supabase session and refreshes its short-lived
access token automatically. Supabase sessions last indefinitely by default, so
a user can remain signed in for a month or longer unless they sign out, delete
their account, a security-sensitive action revokes the session, or an operator
configures an inactivity or maximum-lifetime limit.

Keep the access-token lifetime short (the Supabase default is normally one
hour); refresh tokens maintain the long session. Do not try to make the access
JWT itself last a month. If time-boxed or inactivity limits are enabled, choose
at least 30 days for the requested experience and test refresh after closing and
reopening the installed PWA.

## Verification checklist

1. Request a code for a non-team email address and verify the branded message
   arrives once.
2. Enter the code, reload the browser, and reopen the installed PWA.
3. Confirm another account cannot see, sync, archive, restore, export, or receive
   notifications for the first account's parcel.
4. Sign out and confirm private API requests return `401`.
5. Download account data, then test account deletion with a disposable user.
   Account deletion requires a sign-in from the last ten minutes; an older
   session is signed out and must authenticate again before retrying.

Current upstream references: [email OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless),
[email templates](https://supabase.com/docs/guides/auth/auth-email-templates),
[custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), and
[sessions](https://supabase.com/docs/guides/auth/sessions).
