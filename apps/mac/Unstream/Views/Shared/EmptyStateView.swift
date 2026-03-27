import SwiftUI

struct EmptyStateView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "music.note.list")
                .font(.system(size: 32))
                .foregroundColor(.secondary.opacity(0.5))

            VStack(spacing: 4) {
                Text("No music playing")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.secondary)

                Text("Search for an artist above, or start playing music to see results.")
                    .font(.caption)
                    .foregroundColor(.secondary.opacity(0.7))
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }
}

#Preview {
    EmptyStateView()
        .frame(width: 300)
}
