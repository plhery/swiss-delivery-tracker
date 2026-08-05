"""Generated from contracts/openapi.json. Do not edit."""

CARRIER_CAPABILITIES = {
    "swiss-post": {
        "displayName": "Swiss Post",
        "color": "#ffcc00",
        "selectable": True,
        "timezone": "Europe/Zurich",
        "tracking": {
            "mode": "automatic",
            "adapter": "upstream",
            "upstreamName": "Swiss Post",
        },
        "trackingUrlTemplate": "https://service.post.ch/ekp-web/ui/entry/search/{trackingNumber}",
        "linkRules": (
            {
                "domains": (
                    "service.post.ch",
                ),
                "path": "/entry/search/([^/?#]+)",
            },
        ),
        "detectionRules": (
            {
                "pattern": "^[A-Z]{2}\\d{9}CH$",
                "confidence": "high",
                "checksum": "s10",
            },
            {
                "pattern": "^9[89]\\d{16}$",
                "confidence": "high",
            },
        ),
    },
    "quickpac": {
        "displayName": "Quickpac",
        "color": "#ed1c24",
        "selectable": True,
        "timezone": "Europe/Zurich",
        "tracking": {
            "mode": "automatic",
            "adapter": "upstream",
            "upstreamName": "Quickpac",
        },
        "trackingUrlTemplate": "https://quickpac.ch/en/tracking?parcel={trackingNumber}",
        "linkRules": (
            {
                "domains": (
                    "quickpac.ch",
                ),
                "params": (
                    "parcel",
                ),
            },
        ),
        "detectionRules": (
            {
                "pattern": "^44\\d{16}$",
                "confidence": "high",
            },
        ),
    },
    "planzer": {
        "displayName": "Planzer",
        "color": "#e30613",
        "selectable": True,
        "timezone": "Europe/Zurich",
        "tracking": {
            "mode": "automatic",
            "adapter": "planzer",
            "upstreamName": "Planzer",
            "requirements": (
                {
                    "field": "trackingUrl",
                    "validator": "planzerSharedUrl",
                    "whenTrackingNumber": "^99990\\d{8}$",
                    "label": "Planzer tracking URL",
                    "type": "url",
                    "placeholder": "https://trackandtrace.planzergroup.com/shared/…",
                    "help": "Paste the complete shared link, including its accessKey.",
                },
            ),
        },
        "trackingUrlTemplate": "https://tracking.app.planzer.ch/delivery/info?deliveryNumber={trackingNumber}",
        "linkRules": (
            {
                "domains": (
                    "trackandtrace.planzergroup.com",
                ),
                "path": "/shared/sendungen/([^/?#]+)",
                "keepsCapabilityUrl": True,
            },
            {
                "domains": (
                    "tracking.app.planzer.ch",
                ),
                "params": (
                    "deliveryNumber",
                ),
            },
        ),
        "detectionRules": (
            {
                "pattern": "^99990\\d{8}$",
                "confidence": "high",
            },
            {
                "pattern": "^\\d{20}$",
                "confidence": "high",
            },
        ),
    },
    "aliexpress": {
        "displayName": "AliExpress / Cainiao",
        "color": "#ff4747",
        "selectable": True,
        "timezone": "UTC",
        "tracking": {
            "mode": "automatic",
            "adapter": "upstream",
            "upstreamName": "AliExpress",
        },
        "trackingUrlTemplate": "https://global.cainiao.com/detail.htm?mailNoList={trackingNumber}",
        "linkRules": (
            {
                "domains": (
                    "global.cainiao.com",
                ),
                "params": (
                    "mailNoList",
                ),
            },
        ),
        "detectionRules": (),
    },
    "sunyou": {
        "displayName": "SunYou",
        "color": "#f39800",
        "selectable": True,
        "timezone": "UTC",
        "tracking": {
            "mode": "automatic",
            "adapter": "upstream",
            "upstreamName": "SunYou",
        },
        "trackingUrlTemplate": "https://sypost.net/search?trackNumber={trackingNumber}",
        "linkRules": (
            {
                "domains": (
                    "sypost.net",
                ),
                "params": (
                    "trackNumber",
                ),
            },
        ),
        "detectionRules": (
            {
                "pattern": "^SY\\d{11}$",
                "confidence": "high",
            },
        ),
    },
    "hermes": {
        "displayName": "Hermes Einrichtungs-Service",
        "color": "#0091cd",
        "selectable": True,
        "timezone": "Europe/Zurich",
        "tracking": {
            "mode": "automatic",
            "adapter": "hermes",
        },
        "linkRules": (),
        "detectionRules": (),
    },
    "spring-gds": {
        "displayName": "Spring GDS",
        "color": "#ef7d00",
        "selectable": True,
        "timezone": "UTC",
        "tracking": {
            "mode": "automatic",
            "adapter": "upstream",
            "upstreamName": "Spring GDS",
        },
        "trackingUrlTemplate": "https://postnl.post/details/{trackingNumber}",
        "linkRules": (
            {
                "domains": (
                    "postnl.post",
                ),
                "path": "/details/([^/?#]+)",
            },
        ),
        "detectionRules": (),
    },
    "postlogistics": {
        "displayName": "PostLogistics",
        "color": "#ffcc00",
        "selectable": True,
        "timezone": "Europe/Zurich",
        "tracking": {
            "mode": "automatic",
            "adapter": "upstream",
            "upstreamName": "PostLogistics",
        },
        "linkRules": (),
        "detectionRules": (),
    },
    "dachser": {
        "displayName": "Dachser",
        "color": "#005ca9",
        "selectable": True,
        "timezone": "Europe/Madrid",
        "tracking": {
            "mode": "automatic",
            "adapter": "dachser",
            "requirements": (
                {
                    "field": "trackingUrl",
                    "validator": "dachserCapabilityUrl",
                    "label": "Dachser tracking URL",
                    "type": "url",
                    "placeholder": "https://customeriberia.dachser.com/customerarea/…",
                    "help": "Paste the complete public detail link, including its access parameters.",
                },
            ),
        },
        "linkRules": (
            {
                "domains": (
                    "customeriberia.dachser.com",
                ),
                "params": (
                    "numeroUnico",
                ),
                "keepsCapabilityUrl": True,
            },
        ),
        "detectionRules": (),
    },
    "dhl": {
        "displayName": "DHL",
        "color": "#ffcc00",
        "selectable": True,
        "timezone": "UTC",
        "tracking": {
            "mode": "link-only",
            "adapter": None,
        },
        "trackingUrlTemplate": "https://www.dhl.com/ch-en/home/tracking.html?tracking-id={trackingNumber}",
        "linkRules": (
            {
                "domains": (
                    "dhl.com",
                ),
                "params": (
                    "tracking-id",
                    "trackingId",
                    "piececode",
                ),
            },
        ),
        "detectionRules": (
            {
                "pattern": "^(JJD|JVGL)[A-Z0-9]{8,}$",
                "confidence": "high",
            },
            {
                "pattern": "^\\d{10}$",
                "confidence": "low",
            },
        ),
    },
    "ups": {
        "displayName": "UPS",
        "color": "#351c15",
        "selectable": True,
        "timezone": "UTC",
        "tracking": {
            "mode": "automatic",
            "adapter": "ups",
        },
        "trackingUrlTemplate": "https://www.ups.com/track?tracknum={trackingNumber}",
        "linkRules": (
            {
                "domains": (
                    "ups.com",
                ),
                "params": (
                    "tracknum",
                    "trackNums",
                ),
            },
        ),
        "detectionRules": (
            {
                "pattern": "^1Z[A-Z0-9]{16}$",
                "confidence": "high",
            },
        ),
    },
    "fedex": {
        "displayName": "FedEx",
        "color": "#4d148c",
        "selectable": True,
        "timezone": "UTC",
        "tracking": {
            "mode": "link-only",
            "adapter": None,
        },
        "trackingUrlTemplate": "https://www.fedex.com/fedextrack/?trknbr={trackingNumber}",
        "linkRules": (
            {
                "domains": (
                    "fedex.com",
                ),
                "params": (
                    "trknbr",
                    "tracknumbers",
                ),
            },
        ),
        "detectionRules": (
            {
                "pattern": "^\\d{12}$",
                "confidence": "low",
            },
            {
                "pattern": "^\\d{15}$",
                "confidence": "low",
            },
        ),
    },
    "dpd": {
        "displayName": "DPD",
        "color": "#dc0032",
        "selectable": True,
        "timezone": "Europe/Zurich",
        "tracking": {
            "mode": "automatic",
            "adapter": "dpd",
            "requirements": (
                {
                    "field": "dpdPostcode",
                    "validator": "swissPostcode",
                    "label": "Delivery postcode",
                    "type": "text",
                    "placeholder": "8004",
                    "help": "DPD uses this to unlock verified scans and delivery windows.",
                    "pattern": "^[0-9]{4}$",
                    "maxLength": 4,
                    "inputMode": "numeric",
                    "autoComplete": "postal-code",
                },
            ),
        },
        "trackingUrlTemplate": "https://www.dpdgroup.com/ch/mydpd/my-parcels/incoming?parcelNumber={trackingNumber}",
        "linkRules": (
            {
                "domains": (
                    "dpdgroup.com",
                    "dpd.com",
                ),
                "params": (
                    "parcelNumber",
                    "parcelnumber",
                ),
            },
        ),
        "detectionRules": (
            {
                "pattern": "^\\d{14}$",
                "confidence": "low",
            },
        ),
    },
    "shipup": {
        "displayName": "ShipUp",
        "color": "#5c4ee5",
        "selectable": True,
        "timezone": "UTC",
        "tracking": {
            "mode": "link-only",
            "adapter": None,
        },
        "linkRules": (),
        "detectionRules": (),
    },
    "intl-post": {
        "displayName": "International Post",
        "color": "#2c6fb5",
        "selectable": False,
        "timezone": "UTC",
        "tracking": {
            "mode": "link-only",
            "adapter": None,
        },
        "trackingUrlTemplate": "https://service.post.ch/ekp-web/ui/entry/search/{trackingNumber}",
        "linkRules": (),
        "detectionRules": (
            {
                "pattern": "^[A-Z]{2}\\d{9}(?!CH$)[A-Z]{2}$",
                "confidence": "high",
                "checksum": "s10",
            },
        ),
    },
    "unknown": {
        "displayName": "Carrier",
        "color": "#8e8e93",
        "selectable": False,
        "timezone": "UTC",
        "tracking": {
            "mode": "link-only",
            "adapter": None,
        },
        "linkRules": (),
        "detectionRules": (),
    },
}

CARRIER_IDS = frozenset(
    (
        "swiss-post",
        "quickpac",
        "planzer",
        "aliexpress",
        "sunyou",
        "hermes",
        "spring-gds",
        "postlogistics",
        "dachser",
        "dhl",
        "ups",
        "fedex",
        "dpd",
        "shipup",
        "intl-post",
        "unknown",
    )
)

STAGES = frozenset(
    (
        "pending",
        "registered",
        "accepted",
        "in_transit",
        "out_for_delivery",
        "delivered",
        "customs",
        "failed_attempt",
        "ready_for_pickup",
        "returned",
    )
)

SYNC_STATUSES = frozenset(
    (
        "pending",
        "syncing",
        "ok",
        "waiting",
        "error",
        "unsupported",
    )
)
