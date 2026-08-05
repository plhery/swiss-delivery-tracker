"""Generated from contracts/openapi.json. Do not edit."""

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
