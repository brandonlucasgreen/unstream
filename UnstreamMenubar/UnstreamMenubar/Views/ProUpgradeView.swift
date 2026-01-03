import SwiftUI

struct ProUpgradeView: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "heart.circle.fill")
                .font(.system(size: 40))
                .foregroundColor(.red)

            Text("Unstream Plus")
                .font(.headline)

            Text("Save artists you want to support and access them anytime. Your list syncs across all your Macs via iCloud.")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)

            VStack(spacing: 8) {
                Link(destination: URL(string: "https://unstream.stream/plus")!) {
                    HStack {
                        Image(systemName: "cart")
                        Text("Get Unstream Plus")
                    }
                    .font(.system(size: 13, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.accentColor)
                    .foregroundColor(.white)
                    .cornerRadius(8)
                }

                Button(action: {
                    openWindow(id: "settings")
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }) {
                    Text("I already have a license")
                        .font(.caption)
                        .foregroundColor(.accentColor)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 20)
        .padding(.horizontal)
        .frame(maxWidth: .infinity)
    }
}

#Preview {
    ProUpgradeView()
        .frame(width: 300)
}
