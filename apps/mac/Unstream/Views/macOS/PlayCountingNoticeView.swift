#if os(macOS)
import SwiftUI

/// Shown once after updating into play counting (`PlayCountStore`), so nobody learns about it from
/// a Settings tab they never open. Either action hides it for good.
struct PlayCountingNoticeView: View {
    @Binding var isVisible: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Unstream now counts plays")
                    .font(.headline)

                Spacer()

                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.callout.weight(.semibold))
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundColor(.secondary)
                .help("Dismiss")
                .accessibilityLabel("Dismiss")
            }

            Text("How many times you play each artist, kept on this Mac and never sent anywhere. Next year it'll power a look back at who you listened to.")
                .font(.callout)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Button("Turn it off in Settings") {
                dismiss()
                AppDelegate.shared?.openSettings()
            }
            .buttonStyle(.link)
            .font(.callout)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12).fill(.quaternary.opacity(0.5)))
    }

    private func dismiss() {
        UserDefaults.standard.set(true, forKey: PlayCountStore.noticeSeenKey)
        isVisible = false
    }
}

#Preview {
    PlayCountingNoticeView(isVisible: .constant(true))
        .frame(width: 296)
        .padding()
}
#endif
