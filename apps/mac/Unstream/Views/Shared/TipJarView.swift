import SwiftUI

#if os(iOS)
import StoreKit
#endif

/// Support-Unstream control.
///
/// The two platforms deliberately differ. The Mac app ships as a direct GitHub
/// release, so it links straight to Liberapay — no platform takes a cut, which is
/// the position Unstream argues for everywhere else. The iOS app ships through the
/// App Store, where App Review guideline 3.1.1 requires in-app purchase for tipping
/// the developer and an external donation link is grounds for rejection, so it keeps
/// StoreKit. Don't "simplify" this into one path.
struct TipJarView: View {
    #if os(macOS)
    private static let donateURL = URL(string: "https://liberapay.com/brandonlucasgreen")!

    var body: some View {
        HStack {
            Link(destination: Self.donateURL) {
                Label("Donate via Liberapay", systemImage: "heart.fill")
            }
            .accessibilityLabel("Donate via Liberapay, opens in your browser")

            Spacer()
        }
    }
    #else
    @StateObject private var store = TipJarStore()
    @State private var loadTimedOut = false

    private let tipEmojis = ["☕", "💛", "⭐"]
    private let tipLabels = ["Small tip", "Medium tip", "Large tip"]

    var body: some View {
        VStack(spacing: 12) {
            if store.purchaseState == .success {
                VStack(spacing: 8) {
                    Image(systemName: "heart.fill")
                        .font(.title)
                        .foregroundColor(.red)
                    Text("Thank you!")
                        .font(.headline)
                    Text("Your support means the world.")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .padding(.vertical, 8)
            } else if store.products.isEmpty && loadTimedOut {
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title2)
                        .foregroundColor(.orange)
                    Text("Unable to load. Check your connection and try again.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Retry") {
                        loadTimedOut = false
                        Task {
                            await loadWithTimeout()
                        }
                    }
                    .font(.caption)
                }
            } else if store.products.isEmpty {
                ProgressView()
                    .task {
                        await loadWithTimeout()
                    }
            } else {
                ForEach(Array(store.products.enumerated()), id: \.element.id) { index, product in
                    Button {
                        Task { await store.purchase(product) }
                    } label: {
                        HStack {
                            Text(tipEmojis[safe: index] ?? "💛")
                            Text(tipLabels[safe: index] ?? "Tip")
                                .fontWeight(.medium)
                            Spacer()
                            Text(product.displayPrice)
                                .fontWeight(.semibold)
                        }
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .disabled(store.purchaseState == .purchasing)
                }

                if store.purchaseState == .purchasing {
                    ProgressView("Processing...")
                        .font(.caption)
                }

                if case .failed(let message) = store.purchaseState {
                    Text(message)
                        .font(.caption)
                        .foregroundColor(.red)
                }
            }
        }
    }

    private func loadWithTimeout() async {
        // Start a timeout timer concurrently
        let timeoutTask = Task {
            try? await Task.sleep(nanoseconds: 10_000_000_000) // 10 seconds
            if !Task.isCancelled && store.products.isEmpty {
                await MainActor.run { loadTimedOut = true }
            }
        }

        await store.loadProducts()

        // If products loaded successfully, cancel the timeout
        timeoutTask.cancel()
        if !store.products.isEmpty {
            loadTimedOut = false
        }
    }
    #endif
}

#if os(iOS)
private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
#endif
