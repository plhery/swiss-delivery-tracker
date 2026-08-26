import SwiftUI

enum Brand {
    // The Swiss-yellow accent stays distinctive while the surrounding layers
    // use semantic system colors so contrast, Dark Mode, and increased
    // contrast all adapt with iOS.
    static let accent = Color(uiColor: .systemYellow)
    static let accentBright = Color(uiColor: .systemYellow)
    static let onAccent = Color(hex: "#171714")
    static let ink = Color(uiColor: .label)
    static let cream = Color(uiColor: .tertiarySystemGroupedBackground)
    static let paper = Color(uiColor: .secondarySystemGroupedBackground)
    static let warning = Color(uiColor: .systemOrange)
    static let background = Color(uiColor: .systemGroupedBackground)
    static let separator = Color(uiColor: .separator)
}

extension Color {
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        let value = UInt64(cleaned, radix: 16) ?? 0
        let red = Double((value >> 16) & 0xFF) / 255
        let green = Double((value >> 8) & 0xFF) / 255
        let blue = Double(value & 0xFF) / 255
        self.init(red: red, green: green, blue: blue)
    }
}

extension View {
    @ViewBuilder
    func glassSurface<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: shape)
        } else {
            background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(Brand.separator.opacity(0.72), lineWidth: 0.7))
        }
    }

    func parcelCardSurface(tone: ParcelTone = .normal) -> some View {
        background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Brand.paper)
                .overlay(alignment: .top) {
                    tone.color.frame(height: 2)
                }
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Brand.separator.opacity(0.62), lineWidth: 0.7)
                )
        )
    }
}

struct TactileButtonStyle: ButtonStyle {
    var scale: CGFloat = 0.985
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? scale : 1)
            .opacity(configuration.isPressed ? 0.88 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

struct ParcelGlyph: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                .fill(Brand.accent)
            Image(systemName: "shippingbox.fill")
                .font(.system(size: size * 0.43, weight: .semibold))
                .foregroundStyle(Brand.onAccent)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct StatusBadge: View {
    let status: ParcelDisplayStatus
    @EnvironmentObject private var localizer: Localizer

    var body: some View {
        HStack(spacing: 6) {
            if status.syncing {
                ProgressView().controlSize(.mini)
            } else {
                Circle().fill(status.tone.color).frame(width: 7, height: 7)
            }
            Text(localizer.text(status.key))
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(status.tone == .warning ? Brand.ink : .primary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(status.tone.color.opacity(0.13), in: Capsule())
    }
}

struct DeliveryProgress: View {
    let stage: TrackingStage?
    @EnvironmentObject private var localizer: Localizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let position = stage?.metadata.progress ?? -1
        HStack(spacing: 5) {
            ForEach(Array(TrackingStage.core.enumerated()), id: \.offset) { index, _ in
                Capsule()
                    .fill(index <= position ? (stage?.metadata.tone.color ?? Brand.accent) : Color.secondary.opacity(0.16))
                    .frame(height: index == position ? 5 : 3)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: position)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(localizer.text("native.deliveryProgress"))
        .accessibilityValue(
            position >= 0
                ? localizer.text("progress.step", [
                    "step": position + 1,
                    "total": TrackingStage.core.count,
                    "stage": localizer.text(stage?.localizationKey ?? "status.pending"),
                ])
                : localizer.text("progress.empty")
        )
    }
}

struct CountPill: View {
    let count: Int
    var body: some View {
        Text("\(count)")
            .font(.caption2.weight(.bold).monospacedDigit())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.secondary.opacity(0.1), in: Capsule())
    }
}

struct NoticeBanner: View {
    let symbol: String
    let title: String
    let message: String
    var tint: Color = Brand.accent
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)
                .background(tint.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold))
                if !message.isEmpty {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.plain)
                        .foregroundStyle(tint)
                        .padding(.top, 3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct InlineToast: View {
    let text: String
    let button: String?
    let symbol: String
    let tint: Color
    let action: (() -> Void)?

    init(
        text: String,
        button: String?,
        symbol: String = "checkmark.circle.fill",
        tint: Color = .green,
        action: (() -> Void)?
    ) {
        self.text = text
        self.button = button
        self.symbol = symbol
        self.tint = tint
        self.action = action
    }

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(text).font(.subheadline.weight(.medium)).lineLimit(2)
            Spacer(minLength: 4)
            if let button, let action {
                Button(button, action: action)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(tint)
            }
        }
        .padding(.horizontal, 17)
        .frame(minHeight: 54)
        .foregroundStyle(.primary)
        .glassSurface(in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.13), radius: 8, y: 4)
        .accessibilityElement(children: .combine)
    }
}
