# Carrier support

Delivery Tracker can refresh these French, Swiss and international carriers automatically:

| Carrier | Notes |
| --- | --- |
| Swiss Post | Automatic tracking through the pinned upstream adapter. A contracted business API is preferable for long-term production use. |
| Swiss Post Cargo | Automatic through the official anonymous public tracker. |
| Quickpac | Automatic through Planzer's current tracking API. Existing Quickpac numbers keep their carrier label. |
| Planzer | Automatic. Shared `999.90.########` shipments need the complete shared tracking URL. |
| Cainiao / AliExpress | Automatic. |
| SunYou | Automatic. |
| Hermes Einrichtungs-Service | Automatic. |
| Spring GDS | Automatic. |
| PostLogistics | Automatic. |
| Dachser | Automatic for Customer Iberia shipments when the complete public detail URL is supplied. |
| DPD Switzerland | Automatic through the myDPD guest flow. The parcel's delivery postcode unlocks verified scans and delivery windows. |
| GLS Switzerland | Automatic through GLS's public tracking services. The four-digit recipient postcode unlocks the detailed event history. |
| UPS | Automatic. Direct HTTP is tried first; a private TRAWL instance can handle browser challenges. |
| Amazon Shipping France | Automatic through Amazon Shipping's anonymous recipient tracker for `FR` followed by ten digits. |
| DPD France | Automatic through the recipient trace page. Direct HTTP is tried first; a private TRAWL instance is required when Cloudflare challenges it. |
| Mondial Relay | Automatic through the recipient web flow. Requires the five-digit recipient postcode and can use private TRAWL for Cloudflare. |
| Relais Colis | Automatic through the public recipient form and its CSRF-bound session. |
| La Poste / Colissimo | Automatic through La Poste's public unified tracking feed. |
| Chronopost | Automatic through the same privacy-minimizing La Poste unified feed; the Chronopost SOAP scraper is intentionally not used. |
| GLS France | Automatic through the public recipient-tracking JSON service. |
| Colis Privé | Automatic when the tracking input contains the 12-character shipment number followed by the five-digit recipient postcode. |
| GEODIS | Automatic for the official 12-character `1G…` recipient tracking format. |
| Colisweb | Automatic through the public recipient-search service. |
| C Chez Vous | Automatic through the public order-tracking page. |
| Heppner | Automatic through the public recipient flow. Requires the shipment receipt number and its four- or five-digit delivery postcode. |
| Ciblex | Automatic through the public parcel-tracking page for 14-digit shipment numbers. |
| Paack | Automatic through the public recipient flow. Requires the tracking number and delivery postcode. |

Asendia, DHL, FedEx and International Post parcels are saved with a direct
carrier link. Asendia's public flow requires a fresh Cloudflare Turnstile
validation, while the supported DHL and FedEx tracking APIs require provider
credentials. ShipUp can be kept as a manual record.

Carrier names, adapter modes, tracking links, required inputs, timezones and
detection rules are defined once in `contracts/openapi.json` under
`x-carriers`, then generated for both the Next.js app and native iPhone app. Broad
numeric formats are treated as suggestions and require manual confirmation;
UPU S10 identifiers must pass their check digit before automatic detection.

## French carrier handling and privacy

Amazon Shipping France, DPD France, Mondial Relay, Relais Colis, La Poste / Colissimo, Chronopost, GLS
France, Colis Privé, GEODIS, Colisweb, C Chez Vous, Heppner, Ciblex and Paack
are visible in the manual carrier picker on the web and in both iPhone
interfaces. Recognized tracking links and distinctive number formats can still
select a carrier automatically. Broad numeric formats remain suggestions and
ask the user to confirm the carrier before saving.

La Poste's unified response covers Colissimo, tracked mail and Chronopost. The
adapter validates the returned shipment identifier and retains only normalized
status, date, country and event-code fields. Chronopost therefore does not need
the separate SOAP response, which exposes more consignment metadata and is not
intended for automated extraction.

GLS France and GEODIS responses can include recipient, sender, address, contact,
delivery-instruction and document data. Their adapters build results from a
small allowlist of status/timeline fields rather than copying upstream objects.
GEODIS's anonymous request signature uses the public client key shipped in its
recipient SPA; it is not an account secret, but it can rotate with a frontend
deployment.
Colis Privé's HTML adapter similarly removes the destination block before it
reads the status banner and timeline. The Colis Privé combined credential ends
in the recipient postcode, so treat it like a tracking secret and keep it out
of logs and public issues.

Colisweb, C Chez Vous, Heppner, Ciblex and Paack use their public recipient
flows. Their adapters verify the returned shipment identifier when the provider
supplies one and retain only normalized status, delivery estimate, scan time,
event code and coarse operational-location fields. Recipient names, street
addresses, contact details and delivery instructions are discarded. Heppner
and Paack require the delivery postcode; treat it as part of the tracking
credential. C Chez Vous order references grant access to a public order page
and should be handled the same way.

Colisweb currently returns an empty HTTP 500 for a validly shaped unknown
shipment. Because that response does not prove that the shipment is absent, the
adapter reports an indeterminate upstream failure instead of converting it to a
false not-found result.

DPD France exposes a server-rendered timeline rather than a reusable JSON feed.
Its adapter verifies the outbound or return parcel number before retaining only
timeline status, time and operational location fields. Cloudflare normally
requires the same private TRAWL browser fallback used for UPS. DPD France's
current [site terms](https://www.dpd.com/fr/fr/conditions-generales-utilisation/)
broadly restrict unapproved automated access and extraction, so this integration
is experimental and should be replaced by a contracted API before relying on it
as a long-term production integration.

Mondial Relay's current recipient page calls its own tracking endpoint with an
eight-, ten- or twelve-digit shipment number, the recipient postcode and a
page-scoped verification token. The historic `dpdPostcode` API property and
`dpd_postcode` database column are reused for that five-digit value to preserve
backward compatibility; they remain four digits for DPD Switzerland. Treat the
postcode as part of the tracking credential. TRAWL's Redis-backed session cache
keeps the page token and API request on the same solved browser identity. Relais
Colis uses a normal bounded HTTP session: the adapter obtains the form's CSRF
token, submits the shipment number, verifies the echoed identifier and projects
only timeline fields.

These frontend endpoints are undocumented and can change without notice. The
adapters use bounded responses, timeouts, strict input and response-identity
checks, and privacy-safe projections; failures remain visible for retry. La
Poste's supported Okapi-key API is the preferred future production path when
deployment credentials are available.

Amazon Shipping's public France tracker exposes the shipment summary and event
history used by its recipient page. The adapter retains only status, dates,
event codes and coarse city/region/country locations. It discards recipient,
full-address, postcode, shipper and proof-of-delivery fields. Amazon does not
echo the requested tracking ID in this response, so the adapter validates the
request format and response structure but cannot perform an echoed identifier
check. Detailed history is normally retained for only 45 days.

## Swiss carrier handling and privacy

Swiss Post Cargo uses the anonymous endpoint called by its official public
tracker. The adapter validates the response shape and retains only normalized
tracking history. GLS Switzerland first resolves the public parcel overview,
then uses the recipient's four-digit postcode to request its detailed history.
The GLS adapter keeps coarse scan city and country fields but drops street,
postcode, recipient and contact data returned alongside them. Treat the GLS
postcode as part of the tracking credential.

## AliExpress handoff to Swiss Post

Valid tracked letter-post S10 identifiers in the `L…CH` range are checked
against Swiss Post before every sync. Until Swiss Post announces the shipment,
Cainiao supplies the international tracking history. As soon as Swiss Post has
a usable record, the switch becomes sticky and later refreshes use Swiss Post
as the primary source. The parcel detail keeps links to both carriers and marks
Swiss Post as not ready during the international leg.

## A note about carrier integrations

Several carriers do not offer a supported public tracking API. Their websites
and undocumented endpoints can change without notice, so tracking is best
effort and failures remain visible for later retry. Provider-specific adapters
are isolated under `src/server/`, validate inputs, bound response sizes, and use
timeouts so one carrier cannot block the rest of a scheduled run.

### Opt-in live carrier tests

The regular test suite uses deterministic fixtures and does not depend on
carrier availability. To probe the current anonymous provider endpoints, run:

```bash
npm run test:carriers:live
```

The opt-in suite sends validly shaped, deliberately wrong shipment numbers
through every automatic adapter family. That includes Swiss Post, Swiss Post
Cargo, Planzer and Quickpac, Cainiao, SunYou, Hermes, Spring GDS,
PostLogistics, Dachser, UPS, Amazon Shipping France, GLS Switzerland, DPD Switzerland, DPD France,
Mondial Relay, Relais Colis, La Poste and Chronopost, GLS France, Colis Privé,
GEODIS, Colisweb, C Chez Vous, Heppner, Ciblex and Paack. It also checks
the still-resolving shipment number published by Swiss Post Cargo as its own
example and Hermes's public delivered sample. Retired official examples from
C Chez Vous, GLS Switzerland and Paack exercise the providers' current clean
not-found paths. Customer-posted tracking credentials are deliberately excluded
from committed fixtures, even when they remain publicly searchable. Amazon's
live suite always tests the official wrong-number response; set
`AMAZON_LOGISTICS_LIVE_TRACKING_NUMBER` to additionally exercise a real shipment
without committing that tracking credential.

Several canaries intentionally have different expectations. Colisweb's wrong-number
test asserts the observed empty upstream HTTP 500 is reported as an
indeterminate `502`, not mislabeled as a `404`. Ciblex normally returns an echoed
empty table (a clean `404`), but its transient bare-empty `200` remains an
indeterminate upstream error. DPD's canary likewise accepts its explicitly
recognized Cloudflare fallback when the guest API is temporarily unavailable.
The Dachser endpoint alternates between an explicit null-result error and a
generic HTTP 500 for the same invalid capability tuple; its canary requires a
recognized rejection but deliberately keeps the generic response indeterminate.
UPS, DPD France and Mondial Relay likewise accept only their exact recognized
browser-challenge errors when direct anonymous access is blocked. La Poste's
edge may reject an anonymous lookup with a provider-scoped HTTP 403 before it
can return the normal not-found response. Asendia remains link-only; its canary
verifies that a rejected Cloudflare Turnstile token is recognized as a
challenge, not that an anonymous tracking lookup succeeds. These tests contact
external services and are therefore excluded from the default test command.

## Planzer shared links

Shared Planzer shipments use a capability URL containing an `accessKey`. Paste
the complete `trackandtrace.planzergroup.com/shared/sendungen/...` URL. Treat it
like a tracking secret: keep it out of logs, screenshots and public issues.

Quickpac's 18-digit `44…` identifiers now use the same Planzer API and public
tracking page as ordinary Planzer deliveries. The separate Quickpac carrier ID
is retained for number detection and display only; it no longer selects the
legacy Quickpac adapter.

## Dachser Customer Iberia links

Dachser shipments require the complete
`customeriberia.dachser.com/customerarea/.../detalle?...` URL. Its query
parameters grant access to the shipment, so treat the URL like a password. The
adapter checks the exact Dachser host, path, shipment number and access fields,
then retains only normalized shipment status and event data. Sender, recipient,
address, contact and proof-of-delivery fields from Dachser are discarded.

## DPD postcode

When adding a DPD parcel, enter its recipient postcode. The app stores those
four digits with that parcel, uses them only for DPD verification, and prefills
the postcode from your most recently added DPD parcel next time.

## UPS browser fallback

UPS first uses a bounded direct HTTP flow and keeps its cookie jar in memory.
When Akamai challenges that request, the service can use a private
[`TRAWL`](https://github.com/germondai/trawl) endpoint to establish a browser
session, then return to ordinary HTTP for structured tracking updates:

```dotenv
FLARESOLVERR_URL=http://trawl:8191
```

Do not expose TRAWL publicly. It controls a real browser and is only a best-effort
fallback when a carrier requires interactive proof.
