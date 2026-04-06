import SwiftUI
import StoreKit

struct TipJarView: View {
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
                    }
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
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
