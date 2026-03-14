import SwiftUI

struct DonationView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "heart.circle.fill")
                .font(.system(size: 40))
                .foregroundColor(.yellow)

            Text("Support Unstream")
                .font(.headline)

            Text("Unstream is free and open source. If you find it useful, consider supporting development.")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)

            Link(destination: URL(string: "https://liberapay.com/unstream")!) {
                HStack {
                    Image(systemName: "heart")
                    Text("Donate via Liberapay")
                }
                .font(.system(size: 13, weight: .medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Color.yellow.opacity(0.15))
                .foregroundColor(.yellow)
                .cornerRadius(8)
            }
        }
        .padding(.vertical, 20)
        .padding(.horizontal)
        .frame(maxWidth: .infinity)
    }
}

#Preview {
    DonationView()
        .frame(width: 300)
}
