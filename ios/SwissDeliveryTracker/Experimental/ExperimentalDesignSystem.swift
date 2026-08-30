import SwiftUI

enum ExperimentalPalette {
    static let transit = Color(red: 0.16, green: 0.48, blue: 0.95)
    static let pickup = Color(red: 1.00, green: 0.55, blue: 0.10)
    static let delivered = Color(red: 0.12, green: 0.68, blue: 0.38)

    static func tint(for parcel: Parcel) -> Color {
        switch parcel.currentStage {
        case .delivered:
            delivered
        case .customs, .failedAttempt, .readyForPickup, .returned:
            pickup
        case .inTransit:
            transit
        default:
            Brand.accent
        }
    }
}

struct ExperimentalBackdrop: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drifting = false

    var body: some View {
        ZStack {
            Brand.background

            Circle()
                .fill(Brand.accent.opacity(colorScheme == .dark ? 0.13 : 0.23))
                .frame(width: 390, height: 390)
                .blur(radius: 74)
                .offset(x: drifting ? 145 : 72, y: -340)

            Circle()
                .fill(ExperimentalPalette.transit.opacity(colorScheme == .dark ? 0.08 : 0.12))
                .frame(width: 320, height: 320)
                .blur(radius: 88)
                .offset(x: drifting ? -150 : -90, y: 260)

            LinearGradient(
                colors: [.clear, Brand.background.opacity(0.72), Brand.background],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .ignoresSafeArea()
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 12).repeatForever(autoreverses: true)) {
                drifting = true
            }
        }
    }
}

extension View {
    func experimentalSurface(
        tint: Color = .clear,
        cornerRadius: CGFloat = 26,
        shadow: Bool = true
    ) -> some View {
        background {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(.regularMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [tint.opacity(0.14), tint.opacity(0.025), .clear],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                }
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(
                            LinearGradient(
                                colors: [
                                    .white.opacity(0.52),
                                    .white.opacity(0.16),
                                    tint.opacity(0.18),
                                    .white.opacity(0.08),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 0.8
                        )
                }
                .shadow(
                    color: shadow ? tint.opacity(0.08) : .clear,
                    radius: shadow ? 28 : 0,
                    y: shadow ? 12 : 0
                )
                .shadow(
                    color: shadow ? .black.opacity(0.08) : .clear,
                    radius: shadow ? 18 : 0,
                    y: shadow ? 9 : 0
                )
        }
    }

    func experimentalGlassSheen(
        cornerRadius: CGFloat = 26,
        delay: Double = 0.35
    ) -> some View {
        modifier(ExperimentalGlassSheenModifier(cornerRadius: cornerRadius, delay: delay))
    }
}

private struct ExperimentalGlassSheenModifier: ViewModifier {
    let cornerRadius: CGFloat
    let delay: Double

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var swept = false

    func body(content: Content) -> some View {
        content
            .overlay {
                GeometryReader { geometry in
                    LinearGradient(
                        colors: [
                            .clear,
                            .white.opacity(colorScheme == .dark ? 0.12 : 0.32),
                            .clear,
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: max(72, geometry.size.width * 0.24), height: geometry.size.height * 1.8)
                    .rotationEffect(.degrees(17))
                    .offset(
                        x: swept ? geometry.size.width * 1.28 : -geometry.size.width * 0.52,
                        y: -geometry.size.height * 0.38
                    )
                }
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            .task {
                guard !reduceMotion, !swept else { return }
                try? await Task.sleep(for: .seconds(delay))
                withAnimation(.smooth(duration: 1.15)) {
                    swept = true
                }
            }
    }
}

struct ExperimentalLiftButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.975 : 1)
            .offset(y: configuration.isPressed && !reduceMotion ? 1.5 : 0)
            .brightness(configuration.isPressed ? -0.025 : 0)
            .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: configuration.isPressed)
    }
}

struct ExperimentalCarrierToken: View {
    let carrier: CarrierDefinition
    let tint: Color

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "shippingbox.fill")
                .font(.caption2.weight(.bold))
            Text(carrier.displayName)
                .lineLimit(1)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.primary)
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(tint.opacity(0.14), in: Capsule())
        .overlay(Capsule().stroke(tint.opacity(0.22), lineWidth: 0.7))
    }
}

struct ExperimentalStatusPill: View {
    let text: String
    let symbol: String
    let tint: Color
    var isLive = false

    var body: some View {
        HStack(spacing: 6) {
            if isLive {
                ExperimentalLiveDot(tint: tint, size: 6)
            } else {
                Image(systemName: symbol)
                    .font(.caption2.weight(.bold))
            }
            Text(text)
        }
            .font(.caption.weight(.bold))
            .lineLimit(1)
            .foregroundStyle(.primary)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(tint.opacity(0.15), in: Capsule())
    }
}

struct ExperimentalLiveDot: View {
    let tint: Color
    var size: CGFloat = 7

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let elapsed = context.date.timeIntervalSinceReferenceDate
            let phase = reduceMotion ? 0.35 : elapsed.truncatingRemainder(dividingBy: 1.8) / 1.8

            ZStack {
                Circle()
                    .stroke(tint.opacity(0.52 * (1 - phase)), lineWidth: 1.2)
                    .scaleEffect(1 + phase * 1.25)
                Circle()
                    .fill(tint)
                    .padding(size * 0.2)
                    .shadow(color: tint.opacity(0.42), radius: 3)
            }
        }
        .frame(width: size, height: size)
        .padding(size * 0.55)
        .accessibilityHidden(true)
    }
}

struct ExperimentalRouteLine: View {
    let tint: Color
    var animated = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || !animated)) { context in
                let elapsed = context.date.timeIntervalSinceReferenceDate
                let phase = animated && !reduceMotion
                    ? elapsed.truncatingRemainder(dividingBy: 3.6) / 3.6
                    : (animated ? 0.62 : 1)
                let travel = max(0, geometry.size.width - 8)

                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(tint.opacity(0.13))
                        .frame(height: 2)

                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [tint.opacity(0.32), tint, tint.opacity(0.32)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(height: 2)

                    if animated {
                        Circle()
                            .fill(.white)
                            .overlay(Circle().fill(tint).padding(1.6))
                            .frame(width: 8, height: 8)
                            .shadow(color: tint.opacity(0.54), radius: 5)
                            .offset(x: travel * phase)
                    }
                }
                .frame(maxHeight: .infinity)
            }
        }
        .frame(minWidth: 36, minHeight: 12)
        .accessibilityHidden(true)
    }
}

struct ExperimentalJourneyRail: View {
    let stage: TrackingStage?
    let tint: Color
    var compact = false

    @EnvironmentObject private var localizer: Localizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let current = max(0, min(stage?.metadata.progress ?? 0, TrackingStage.core.count - 1))
        let denominator = CGFloat(max(1, TrackingStage.core.count - 1))

        GeometryReader { geometry in
            let markerSize: CGFloat = compact ? 24 : 30
            let start = markerSize / 2
            let travel = max(0, geometry.size.width - markerSize)
            let fraction = CGFloat(current) / denominator

            ZStack {
                Capsule()
                    .fill(.secondary.opacity(0.14))
                    .frame(height: compact ? 3 : 4)
                    .padding(.horizontal, start)

                HStack(spacing: 0) {
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [tint.opacity(0.76), tint],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: max(3, travel * fraction), height: compact ? 3 : 4)
                    Spacer(minLength: 0)
                }
                .padding(.leading, start)
                .padding(.trailing, start)

                ForEach(Array(TrackingStage.core.enumerated()), id: \.offset) { index, _ in
                    Circle()
                        .fill(index <= current ? tint : Color.secondary.opacity(0.22))
                        .frame(width: compact ? 6 : 7, height: compact ? 6 : 7)
                        .position(
                            x: start + travel * CGFloat(index) / denominator,
                            y: markerSize / 2
                        )
                }

                ZStack {
                    if stage == .outForDelivery {
                        ExperimentalLiveDot(tint: tint, size: markerSize * 0.62)
                    }
                    Circle().fill(.regularMaterial)
                    Circle().fill(tint.opacity(0.16)).padding(2)
                    Image(systemName: stage?.metadata.symbol ?? "shippingbox.fill")
                        .font(.system(size: compact ? 10 : 12, weight: .bold))
                        .foregroundStyle(.primary)
                        .symbolEffect(.bounce, value: current)
                }
                .frame(width: markerSize, height: markerSize)
                .overlay(Circle().stroke(.white.opacity(0.34), lineWidth: 0.7))
                .position(x: start + travel * fraction, y: markerSize / 2)
                .animation(reduceMotion ? nil : .snappy(duration: 0.5, extraBounce: 0.08), value: current)
            }
        }
        .frame(height: compact ? 24 : 30)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(localizer.text("native.deliveryProgress"))
        .accessibilityValue(
            localizer.text("progress.step", [
                "step": current + 1,
                "total": TrackingStage.core.count,
                "stage": localizer.text(stage?.localizationKey ?? "status.pending"),
            ])
        )
    }
}

struct ExperimentalParcelStatistics: Equatable {
    let trackedCount: Int
    let deliveredCount: Int
    let activeCount: Int
    let carrierCount: Int
    let placeCount: Int
    let favoriteCarrier: CarrierID?
    let deliveredParcels: [Parcel]

    init(parcels: [Parcel]) {
        trackedCount = parcels.count
        deliveredCount = parcels.filter(\.isDelivered).count
        activeCount = parcels.filter(\.isActive).count
        carrierCount = Set(parcels.map(\.carrier)).count
        placeCount = Set(
            parcels.flatMap(\.trackingEvents).compactMap { event in
                event.location?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            }
        ).count
        deliveredParcels = parcels.filter(\.isDelivered).sorted {
            ($0.currentEvent?.occurredAt ?? $0.createdAt) > ($1.currentEvent?.occurredAt ?? $1.createdAt)
        }

        let counts = Dictionary(grouping: parcels, by: \.carrier).mapValues { $0.count }
        favoriteCarrier = counts.sorted { left, right in
            if left.value == right.value { return left.key.rawValue < right.key.rawValue }
            return left.value > right.value
        }.first?.key
    }
}

struct ExperimentalCopy {
    let language: AppLanguage

    var passport: String { value(en: "Passport", de: "Pass", fr: "Passeport", it: "Passaporto") }
    var yearInMotion: String {
        value(en: "Your deliveries in motion", de: "Deine Lieferungen in Bewegung", fr: "Vos livraisons en mouvement", it: "Le tue consegne in movimento")
    }
    var tracked: String { value(en: "Tracked", de: "Verfolgt", fr: "Suivis", it: "Tracciati") }
    var delivered: String { value(en: "Delivered", de: "Zugestellt", fr: "Livrés", it: "Consegnati") }
    var active: String { value(en: "On the way", de: "Unterwegs", fr: "En route", it: "In viaggio") }
    var carriers: String { value(en: "Carriers", de: "Anbieter", fr: "Transporteurs", it: "Corrieri") }
    var places: String { value(en: "Places", de: "Orte", fr: "Lieux", it: "Luoghi") }
    var memories: String { value(en: "Made it home", de: "Angekommen", fr: "Arrivés à bon port", it: "Arrivati a casa") }
    var noMemories: String {
        value(en: "Completed deliveries will collect here.", de: "Abgeschlossene Lieferungen sammeln sich hier.", fr: "Les livraisons terminées apparaîtront ici.", it: "Le consegne completate appariranno qui.")
    }
    var archiveHint: String {
        value(en: "Past journeys, tucked away", de: "Vergangene Wege, gut verstaut", fr: "Les anciens trajets, bien rangés", it: "I viaggi passati, ben custoditi")
    }
    var showArchive: String {
        value(en: "Show archived parcels", de: "Archivierte Pakete anzeigen", fr: "Afficher les colis archivés", it: "Mostra i pacchi archiviati")
    }
    var hideArchive: String {
        value(en: "Hide archived parcels", de: "Archivierte Pakete ausblenden", fr: "Masquer les colis archivés", it: "Nascondi i pacchi archiviati")
    }
    var currentUpdate: String { value(en: "Current update", de: "Aktueller Stand", fr: "Dernière nouvelle", it: "Ultimo aggiornamento") }
    var fullJourney: String { value(en: "Show full journey", de: "Ganze Reise zeigen", fr: "Afficher tout le trajet", it: "Mostra tutto il viaggio") }
    var lessJourney: String { value(en: "Show less", de: "Weniger zeigen", fr: "Afficher moins", it: "Mostra meno") }
    var shipmentDetails: String { value(en: "Shipment details", de: "Sendungsdetails", fr: "Détails de l’envoi", it: "Dettagli della spedizione") }
    var home: String { value(en: "Home", de: "Zuhause", fr: "Domicile", it: "Casa") }
    var smartCapture: String { value(en: "Smart capture", de: "Schnellerfassung", fr: "Capture intelligente", it: "Acquisizione smart") }
    var scanOrEnter: String {
        value(en: "Paste anything from a shipping message. We’ll find the useful part.", de: "Füge etwas aus einer Versandnachricht ein. Wir finden den nützlichen Teil.", fr: "Collez un extrait d’un message d’expédition. Nous trouverons l’essentiel.", it: "Incolla un testo da un messaggio di spedizione. Troveremo la parte utile.")
    }
    var ready: String { value(en: "Ready to review", de: "Bereit zur Prüfung", fr: "Prêt à vérifier", it: "Pronto da verificare") }
    var chooseNext: String {
        value(en: "Carrier details can be confirmed next.", de: "Anbieterdetails können als Nächstes bestätigt werden.", fr: "Vous pourrez ensuite confirmer le transporteur.", it: "Potrai confermare i dettagli del corriere nel passaggio successivo.")
    }
    var continueTitle: String { value(en: "Review parcel", de: "Paket prüfen", fr: "Vérifier le colis", it: "Verifica il pacco") }
    var scanTitle: String { value(en: "Scan instead", de: "Stattdessen scannen", fr: "Scanner plutôt", it: "Scansiona invece") }

    private func value(en: String, de: String, fr: String, it: String) -> String {
        switch language {
        case .en: en
        case .de: de
        case .fr: fr
        case .it: it
        }
    }
}

extension Parcel {
    var experimentalLatestLocation: String? {
        sortedEvents.compactMap { $0.location?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty }.first
    }
}
