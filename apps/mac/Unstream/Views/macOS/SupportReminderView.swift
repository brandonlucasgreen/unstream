#if os(macOS)
import SwiftUI

/// The occasional "consider supporting Unstream" card in the popover's empty state.
/// `SupportReminder` decides when it appears; every action here hides it and snoozes it.
struct SupportReminderView: View {
    @Binding var isVisible: Bool
    @Environment(\.openURL) private var openURL

    private static let kofiURL = URL(string: "https://ko-fi.com/bgreenlol")!
    private static let kofiRed = Color(red: 1.0, green: 0x5E / 255, blue: 0x5B / 255)

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Keep Unstream running")
                    .font(.subheadline.weight(.semibold))

                Spacer()

                Button {
                    dismiss(days: SupportReminder.snoozeDays)
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundColor(.secondary)
                .help("Not now")
                .accessibilityLabel("Not now")
            }

            Text("Unstream is free, with no ads. If it's helped you find artists to support, consider chipping in.")
                .font(.caption)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 10) {
                Button {
                    dismiss(days: SupportReminder.snoozeDays)
                    openURL(Self.kofiURL)
                } label: {
                    Label {
                        Text("Support on Ko-fi")
                    } icon: {
                        Image("KofiIcon")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 12, height: 12)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Self.kofiRed)
                .controlSize(.small)
                .accessibilityLabel("Support Unstream on Ko-fi, opens in your browser")

                Button("I already support Unstream") {
                    dismiss(days: SupportReminder.alreadySupportDays)
                }
                .buttonStyle(.link)
                .font(.caption)
            }
            .padding(.top, 4)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary.opacity(0.5)))
    }

    private func dismiss(days: Int) {
        SupportReminderStore.snooze(days: days)
        isVisible = false
    }
}

#Preview {
    SupportReminderView(isVisible: .constant(true))
        .frame(width: 296)
        .padding()
}
#endif
