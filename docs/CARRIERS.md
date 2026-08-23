# Carrier support

Swiss Delivery Tracker can refresh these carriers automatically:

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

DHL, FedEx and International Post parcels are saved with a direct carrier link.
ShipUp can be kept as a manual record.

Carrier names, adapter modes, tracking links, required inputs, timezones and
detection rules are defined once in `contracts/openapi.json` under
`x-carriers`, then generated for both the Next.js app and native iPhone app. Broad
numeric formats are treated as suggestions and require manual confirmation;
UPU S10 identifiers must pass their check digit before automatic detection.

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
