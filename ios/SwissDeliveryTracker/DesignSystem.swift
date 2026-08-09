import SwiftUI

enum Brand {
    static let accent = Color(hex: "#F4C900")
    static let accentBright = Color(hex: "#FFD60A")
    static let ink = Color(hex: "#171714")
    static let cream = Color(hex: "#F7F3EA")
    static let paper = Color(hex: "#FFFCF6")
    static let warning = Color(hex: "#F28C28")
    static let background = LinearGradient(
        colors: [Color(hex: "#F7F3EA"), Color(hex: "#F2EEE7")],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
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
                .overlay(shape.stroke(.white.opacity(0.52), lineWidth: 0.7))
        }
    }

    func parcelCardSurface(tone: ParcelTone = .normal) -> some View {
        background(
            RoundedRectangle(cornerRadius: 21, style: .continuous)
                .fill(Brand.paper)
                .overlay(alignment: .top) {
                    tone.color.frame(height: 3)
                }
                .clipShape(RoundedRectangle(cornerRadius: 21, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 21, style: .continuous)
                        .stroke(Brand.ink.opacity(0.065), lineWidth: 0.7)
                )
                .shadow(color: Brand.ink.opacity(0.055), radius: 11, y: 6)
        )
    }
}

struct TactileButtonStyle: ButtonStyle {
    var scale: CGFloat = 0.985

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? 0.88 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

struct ParcelGlyph: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                .fill(Brand.accentBright)
            Image(systemName: "shippingbox.fill")
                .font(.system(size: size * 0.43, weight: .semibold))
                .symbolRenderingMode(.palette)
                .foregroundStyle(Brand.ink, Brand.paper)
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

    var body: some View {
        let position = stage?.metadata.progress ?? -1
        HStack(spacing: 5) {
            ForEach(Array(TrackingStage.core.enumerated()), id: \.offset) { index, _ in
                Capsule()
                    .fill(index <= position ? (stage?.metadata.tone.color ?? Brand.accent) : Color.secondary.opacity(0.16))
                    .frame(height: index == position ? 5 : 3)
                    .animation(.snappy, value: position)
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
                Text(message).font(.caption).foregroundStyle(.secondary)
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
        .background(tint.opacity(0.075), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct InlineToast: View {
    let text: String
    let button: String?
    let action: (() -> Void)?

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "archivebox.fill").foregroundStyle(Brand.accent)
            Text(text).font(.subheadline.weight(.medium)).lineLimit(2)
            Spacer(minLength: 4)
            if let button, let action {
                Button(button, action: action)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Brand.accent)
            }
        }
        .padding(.horizontal, 17)
        .frame(minHeight: 54)
        .foregroundStyle(.primary)
        .glassSurface(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .shadow(color: .black.opacity(0.14), radius: 18, y: 8)
    }
}
