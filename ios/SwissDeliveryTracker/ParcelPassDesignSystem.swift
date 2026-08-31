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

    var body: some View {
        ZStack {
            Brand.background

            LinearGradient(
                colors: [
                    Brand.accent.opacity(colorScheme == .dark ? 0.055 : 0.08),
                    .clear,
                ],
                startPoint: .topTrailing,
                endPoint: .center
            )
        }
        .ignoresSafeArea()
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
                .fill(Brand.paper)
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(tint.opacity(0.035))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(Brand.separator.opacity(0.42), lineWidth: 0.6)
                }
                .shadow(
                    color: shadow ? .black.opacity(0.035) : .clear,
                    radius: shadow ? 10 : 0,
                    y: shadow ? 4 : 0
                )
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

struct ExperimentalJourneyRail: View {
    let stage: TrackingStage?
    let tint: Color
    var compact = false

    @EnvironmentObject private var localizer: Localizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let current = max(0, min(stage?.metadata.progress ?? 0, TrackingStage.core.count - 1))

        HStack(spacing: compact ? 4 : 5) {
            ForEach(Array(TrackingStage.core.enumerated()), id: \.offset) { index, _ in
                Capsule()
                    .fill(index <= current ? tint : Color.secondary.opacity(0.15))
                    .frame(height: index == current ? (compact ? 4 : 5) : 3)
            }
        }
        .frame(height: compact ? 5 : 6)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: current)
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
        value(en: "Delivery history", de: "Lieferverlauf", fr: "Historique des livraisons", it: "Cronologia delle consegne")
    }
    var tracked: String { value(en: "Tracked", de: "Verfolgt", fr: "Suivis", it: "Tracciati") }
    var delivered: String { value(en: "Delivered", de: "Zugestellt", fr: "Livrés", it: "Consegnati") }
    var active: String { value(en: "On the way", de: "Unterwegs", fr: "En route", it: "In viaggio") }
    var carriers: String { value(en: "Carriers", de: "Anbieter", fr: "Transporteurs", it: "Corrieri") }
    var places: String { value(en: "Places", de: "Orte", fr: "Lieux", it: "Luoghi") }
    var mostUsedCarrier: String { value(en: "Most used", de: "Meistgenutzt", fr: "Plus utilisé", it: "Più usato") }
    var memories: String { value(en: "Recent deliveries", de: "Letzte Lieferungen", fr: "Livraisons récentes", it: "Consegne recenti") }
    var noMemories: String {
        value(en: "Delivered parcels will appear here.", de: "Zugestellte Pakete erscheinen hier.", fr: "Les colis livrés apparaîtront ici.", it: "I pacchi consegnati appariranno qui.")
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
    var smartCapture: String { value(en: "Smart capture", de: "Schnellerfassung", fr: "Capture intelligente", it: "Acquisizione smart") }
    var scanOrEnter: String {
        value(en: "Paste anything from a shipping message. We’ll find the useful part.", de: "Füge etwas aus einer Versandnachricht ein. Wir finden den nützlichen Teil.", fr: "Collez un extrait d’un message d’expédition. Nous trouverons l’essentiel.", it: "Incolla un testo da un messaggio di spedizione. Troveremo la parte utile.")
    }
    var quickAddIntro: String {
        value(en: "Name it, drop in the tracking number, done.", de: "Benennen, Sendungsnummer einfügen, fertig.", fr: "Nommez-le, ajoutez le numéro de suivi, c’est fait.", it: "Dagli un nome, inserisci il numero, fatto.")
    }
    var parcelTitle: String { value(en: "Title", de: "Titel", fr: "Titre", it: "Titolo") }
    var trackingReady: String {
        value(en: "Ready to add", de: "Bereit zum Hinzufügen", fr: "Prêt à ajouter", it: "Pronto da aggiungere")
    }
    var oneMoreDetail: String {
        value(en: "One detail needed", de: "Noch eine Angabe", fr: "Un détail nécessaire", it: "Serve ancora un dettaglio")
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
