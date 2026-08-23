import ActivityKit
import SwiftUI
import WidgetKit

private struct DeliveryWidgetEntry: TimelineEntry {
    let date: Date
    let enabled: Bool
    let languageCode: String
    let snapshot: DeliveryWidgetSnapshot?
}

private struct DeliveryWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> DeliveryWidgetEntry {
        let languageCode = preferredLanguageCode
        let copy = DeliveryWidgetLocalizer(languageCode: languageCode)
        return DeliveryWidgetEntry(
            date: Date(),
            enabled: true,
            languageCode: languageCode,
            snapshot: DeliveryWidgetSnapshot(
                generatedAt: Date(),
                languageCode: languageCode,
                parcels: [
                    DeliveryWidgetParcel(
                        id: UUID(),
                        label: copy.text("common.parcel"),
                        carrier: "Swiss Post",
                        trackingNumber: "99.34.123456.12345678",
                        detail: copy.text("time.today"),
                        isOutForDelivery: true
                    ),
                ]
            )
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (DeliveryWidgetEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DeliveryWidgetEntry>) -> Void) {
        let entry = currentEntry()
        let refresh = Calendar.current.date(byAdding: .minute, value: 20, to: entry.date)
            ?? entry.date.addingTimeInterval(1_200)
        completion(Timeline(entries: [entry], policy: .after(refresh)))
    }

    private func currentEntry() -> DeliveryWidgetEntry {
        let identifier = DeliveryWidgetSharedStore.appGroupIdentifier()
        let store = DeliveryWidgetSharedStore(appGroupIdentifier: identifier)
        let snapshot = store?.snapshot
        let languageCode = snapshot?.languageCode
            ?? store?.languageCode
            ?? preferredLanguageCode
        return DeliveryWidgetEntry(
            date: Date(),
            enabled: store?.isEnabled ?? true,
            languageCode: languageCode,
            snapshot: snapshot
        )
    }

    private var preferredLanguageCode: String {
        guard let code = Locale.preferredLanguages.first.map({
            String($0.prefix(2)).lowercased()
        }), ["en", "de", "fr", "it"].contains(code) else {
            return "en"
        }
        return code
    }
}

private struct DeliveryWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: DeliveryWidgetEntry

    private var copy: DeliveryWidgetLocalizer {
        DeliveryWidgetLocalizer(languageCode: entry.languageCode)
    }

    private var parcels: [DeliveryWidgetParcel] {
        entry.snapshot?.parcels ?? []
    }

    var body: some View {
        Group {
            if !entry.enabled {
                stateView(
                    symbol: "rectangle.slash",
                    title: copy.text("widget.disabledTitle"),
                    description: copy.text("widget.disabledDescription")
                )
            } else if parcels.isEmpty {
                stateView(
                    symbol: "shippingbox",
                    title: copy.text("app.noneOnWay"),
                    description: copy.text("app.emptyDescription")
                )
            } else if family == .systemMedium {
                mediumContent
            } else {
                smallContent(parcels[0])
            }
        }
        .foregroundStyle(WidgetPalette.ink)
        .containerBackground(for: .widget) {
            LinearGradient(
                colors: [WidgetPalette.accentBright, WidgetPalette.accent],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
        .widgetURL(family == .systemSmall ? parcels.first?.deepLink : nil)
        .environment(\.locale, Locale(identifier: entry.languageCode))
    }

    private func smallContent(_ parcel: DeliveryWidgetParcel) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            widgetHeader
            parcelBadge(parcel)
            Text(parcel.label)
                .font(.headline.weight(.bold))
                .lineLimit(2)
                .minimumScaleFactor(0.82)
            Spacer(minLength: 2)
            Text(parcel.carrier)
                .font(.caption.weight(.semibold))
                .foregroundStyle(WidgetPalette.ink.opacity(0.68))
                .lineLimit(1)
            Text(parcel.detail)
                .font(.caption.weight(.bold))
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    private var mediumContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            widgetHeader
            HStack(spacing: 10) {
                ForEach(parcels.prefix(2)) { parcel in
                    Link(destination: parcel.deepLink) {
                        VStack(alignment: .leading, spacing: 5) {
                            parcelBadge(parcel)
                            Text(parcel.label)
                                .font(.subheadline.weight(.bold))
                                .lineLimit(1)
                            Text(parcel.carrier)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(WidgetPalette.ink.opacity(0.64))
                                .lineLimit(1)
                            Text(parcel.detail)
                                .font(.caption.weight(.bold))
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .padding(10)
                        .background(.white.opacity(0.36), in: RoundedRectangle(cornerRadius: 14))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
                }
                if parcels.count == 1 { Spacer(minLength: 0) }
            }
        }
    }

    private var widgetHeader: some View {
        HStack(spacing: 6) {
            Image(systemName: "shippingbox.fill")
                .font(.caption.weight(.bold))
            Text(copy.text("app.title"))
                .font(.caption2.weight(.heavy))
                .textCase(.uppercase)
                .tracking(0.6)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .foregroundStyle(WidgetPalette.ink.opacity(0.72))
    }

    private func parcelBadge(_ parcel: DeliveryWidgetParcel) -> some View {
        Label(
            copy.text(parcel.isOutForDelivery ? "stage.out_for_delivery" : "app.nextUp"),
            systemImage: parcel.isOutForDelivery ? "bicycle" : "arrow.right.circle.fill"
        )
        .font(.caption2.weight(.heavy))
        .textCase(.uppercase)
        .lineLimit(1)
    }

    private func stateView(symbol: String, title: String, description: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: symbol)
                .font(.title2.weight(.bold))
            Text(title)
                .font(.headline.weight(.bold))
                .lineLimit(2)
            Text(description)
                .font(.caption)
                .foregroundStyle(WidgetPalette.ink.opacity(0.67))
                .lineLimit(family == .systemMedium ? 2 : 3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct DeliveryWidgetLocalizer {
    let languageCode: String

    private static let dictionaries: [String: [String: String]] = {
        guard let url = Bundle.main.url(forResource: "Localization", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let values = try? JSONDecoder().decode([String: [String: String]].self, from: data) else {
            return [:]
        }
        return values
    }()

    func text(_ key: String) -> String {
        Self.dictionaries[languageCode]?[key]
            ?? Self.dictionaries["en"]?[key]
            ?? key
    }
}

private enum WidgetPalette {
    static let accent = Color(red: 0.96, green: 0.73, blue: 0.13)
    static let accentBright = Color(red: 1.0, green: 0.84, blue: 0.34)
    static let ink = Color(red: 0.10, green: 0.10, blue: 0.09)
}

struct NextDeliveryWidget: Widget {
    var body: some WidgetConfiguration {
        let store = DeliveryWidgetSharedStore(
            appGroupIdentifier: DeliveryWidgetSharedStore.appGroupIdentifier()
        )
        let copy = DeliveryWidgetLocalizer(languageCode: store?.languageCode ?? "en")
        return StaticConfiguration(
            kind: DeliveryWidgetSharedStore.kind,
            provider: DeliveryWidgetProvider()
        ) { entry in
            DeliveryWidgetView(entry: entry)
        }
        .configurationDisplayName(copy.text("widget.galleryName"))
        .description(copy.text("widget.galleryDescription"))
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

private struct DeliveryLiveActivityView: View {
    let state: DeliveryActivityAttributes.ContentState

    private var copy: DeliveryWidgetLocalizer {
        DeliveryWidgetLocalizer(languageCode: state.languageCode)
    }

    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: state.parcel.isOutForDelivery ? "bicycle" : "shippingbox.fill")
                .font(.title3.weight(.bold))
                .frame(width: 42, height: 42)
                .background(WidgetPalette.accent, in: Circle())
                .foregroundStyle(WidgetPalette.ink)
            VStack(alignment: .leading, spacing: 3) {
                Text(copy.text(state.parcel.isOutForDelivery
                    ? "stage.out_for_delivery" : "app.nextUp"))
                    .font(.caption2.weight(.heavy))
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                Text(state.parcel.label)
                    .font(.headline.weight(.bold))
                    .lineLimit(1)
                Text("\(state.parcel.carrier) · \(state.parcel.detail)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
        }
        .padding()
        .activityBackgroundTint(Color(red: 0.12, green: 0.12, blue: 0.11))
        .activitySystemActionForegroundColor(WidgetPalette.accentBright)
        .widgetURL(state.parcel.deepLink)
        .environment(\.locale, Locale(identifier: state.languageCode))
    }
}

struct DeliveryLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DeliveryActivityAttributes.self) { context in
            DeliveryLiveActivityView(state: context.state)
        } dynamicIsland: { context in
            let copy = DeliveryWidgetLocalizer(languageCode: context.state.languageCode)
            let parcel = context.state.parcel
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(
                        copy.text(parcel.isOutForDelivery ? "stage.out_for_delivery" : "app.nextUp"),
                        systemImage: parcel.isOutForDelivery ? "bicycle" : "shippingbox.fill"
                    )
                    .font(.caption.weight(.bold))
                    .foregroundStyle(WidgetPalette.accentBright)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(parcel.detail)
                        .font(.caption.weight(.bold))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(parcel.label)
                            .font(.headline.weight(.bold))
                            .lineLimit(1)
                        Text("\(parcel.carrier) · \(parcel.trackingNumber)")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                Image(systemName: parcel.isOutForDelivery ? "bicycle" : "shippingbox.fill")
                    .foregroundStyle(WidgetPalette.accentBright)
            } compactTrailing: {
                Image(systemName: "chevron.right")
                    .foregroundStyle(WidgetPalette.accentBright)
            } minimal: {
                Image(systemName: parcel.isOutForDelivery ? "bicycle" : "shippingbox.fill")
                    .foregroundStyle(WidgetPalette.accentBright)
            }
            .widgetURL(parcel.deepLink)
            .keylineTint(WidgetPalette.accent)
        }
    }
}

@main
struct DeliveryTrackerWidgetBundle: WidgetBundle {
    var body: some Widget {
        NextDeliveryWidget()
        DeliveryLiveActivityWidget()
    }
}
