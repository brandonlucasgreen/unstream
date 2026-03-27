import StoreKit
import SwiftUI

@MainActor
class TipJarStore: ObservableObject {
    @Published var products: [Product] = []
    @Published var purchaseState: PurchaseState = .idle

    enum PurchaseState: Equatable {
        case idle
        case purchasing
        case success
        case failed(String)

        static func == (lhs: PurchaseState, rhs: PurchaseState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle), (.purchasing, .purchasing), (.success, .success):
                return true
            case (.failed(let a), .failed(let b)):
                return a == b
            default:
                return false
            }
        }
    }

    static let productIDs = [
        "lol.bgreen.unstream.tip.small",
        "lol.bgreen.unstream.tip.medium",
        "lol.bgreen.unstream.tip.large"
    ]

    func loadProducts() async {
        do {
            products = try await Product.products(for: Self.productIDs)
                .sorted { $0.price < $1.price }
        } catch {
            print("[TipJar] Failed to load products: \(error)")
        }
    }

    func purchase(_ product: Product) async {
        purchaseState = .purchasing
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                let transaction = try checkVerified(verification)
                await transaction.finish()
                purchaseState = .success
                // Reset after showing thank you
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                purchaseState = .idle
            case .userCancelled:
                purchaseState = .idle
            case .pending:
                purchaseState = .idle
            @unknown default:
                purchaseState = .idle
            }
        } catch {
            purchaseState = .failed(error.localizedDescription)
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            purchaseState = .idle
        }
    }

    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let safe):
            return safe
        }
    }
}
