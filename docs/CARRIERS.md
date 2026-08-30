# Carrier support

Delivery Tracker can refresh these French, Swiss and international carriers automatically:

| Carrier | Notes |
| --- | --- |
| Swiss Post | Automatic tracking through the pinned upstream adapter. A contracted business API is preferable for long-term production use. |
| Quickpac | Automatic through Planzer's current tracking API. Existing Quickpac numbers keep their carrier label. |
| Planzer | Automatic. Shared `999.90.########` shipments need the complete shared tracking URL. |
| Cainiao / AliExpress | Automatic. |
| SunYou | Automatic. |
| Hermes Einrichtungs-Service | Automatic. |
| Spring GDS | Automatic. |
| PostLogistics | Automatic. |
| Dachser | Automatic for Customer Iberia shipments when the complete public detail URL is supplied. |
| DPD Switzerland | Automatic through the myDPD guest flow. The parcel's delivery postcode unlocks verified scans and delivery windows. |
| UPS | Automatic. Direct HTTP is tried first; a private TRAWL instance can handle browser challenges. |
| DPD France | Automatic through the recipient trace page. Direct HTTP is tried first; a private TRAWL instance is required when Cloudflare challenges it. |
| Mondial Relay | Automatic through the recipient web flow. Requires the five-digit recipient postcode and can use private TRAWL for Cloudflare. |
| Relais Colis | Automatic through the public recipient form and its CSRF-bound session. |
| La Poste / Colissimo | Automatic through La Poste's public unified tracking feed. |
| Chronopost | Automatic through the same privacy-minimizing La Poste unified feed; the Chronopost SOAP scraper is intentionally not used. |
| GLS France | Automatic through the public recipient-tracking JSON service. |
| Colis Privé | Automatic when the tracking input contains the 12-character shipment number followed by the five-digit recipient postcode. |
| GEODIS | Automatic for the official 12-character `1G…` recipient tracking format. |

DHL, FedEx and International Post parcels are saved with a direct carrier link.
ShipUp can be kept as a manual record.

Carrier names, adapter modes, tracking links, required inputs, timezones and
detection rules are defined once in `contracts/openapi.json` under
`x-carriers`, then generated for both the Next.js app and native iPhone app. Broad
numeric formats are treated as suggestions and require manual confirmation;
UPU S10 identifiers must pass their check digit before automatic detection.

## French carrier handling and privacy

DPD France, Mondial Relay, Relais Colis, La Poste / Colissimo, Chronopost, GLS
France, Colis Privé and GEODIS are visible in the manual carrier picker on the
web and in both iPhone interfaces. Recognized tracking links and distinctive
number formats can still select a carrier automatically. Broad numeric formats
remain suggestions and ask the user to confirm the carrier before saving.

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
