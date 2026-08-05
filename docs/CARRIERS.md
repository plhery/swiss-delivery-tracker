# Carrier support

Swiss Delivery Tracker can refresh these carriers automatically:

| Carrier | Notes |
| --- | --- |
| Swiss Post | Automatic tracking through the pinned upstream adapter. A contracted business API is preferable for long-term production use. |
| Quickpac | Automatic. |
| Planzer | Automatic. Shared `999.90.########` shipments need the complete shared tracking URL. |
| Cainiao / AliExpress | Automatic. |
| SunYou | Automatic. |
| Hermes Einrichtungs-Service | Automatic. |
| Spring GDS | Automatic. |
| PostLogistics | Automatic. |
| DPD Switzerland | Automatic through the myDPD guest flow. The parcel's delivery postcode unlocks verified scans and delivery windows. |
| UPS | Automatic. Direct HTTP is tried first; a private TRAWL instance can handle browser challenges. |

DHL, FedEx and International Post parcels are saved with a direct carrier link.
Dachser and ShipUp can be kept as manual records.

## A note about carrier integrations

Several carriers do not offer a supported public tracking API. Their websites
and undocumented endpoints can change without notice, so tracking is best
effort and failures remain visible for later retry. The reusable adapters come
from the pinned
[`blue-plhery-assistant/swiss-delivery-tracker`](https://github.com/blue-plhery-assistant/swiss-delivery-tracker)
package.

## Planzer shared links

Shared Planzer shipments use a capability URL containing an `accessKey`. Paste
the complete `trackandtrace.planzergroup.com/shared/sendungen/...` URL. Treat it
like a tracking secret: keep it out of logs, screenshots and public issues.

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
