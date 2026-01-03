import Foundation

// MARK: - LemonSqueezy License API Response

struct LicenseResponse: Codable {
    let valid: Bool
    let error: String?
    let licenseKey: LicenseKeyInfo?
    let meta: LicenseMeta?

    enum CodingKeys: String, CodingKey {
        case valid, error, meta
        case licenseKey = "license_key"
    }
}

struct LicenseKeyInfo: Codable {
    let id: Int
    let status: String  // "active", "inactive", "expired", "disabled"
    let key: String
    let activationLimit: Int?
    let activationUsage: Int?
    let createdAt: String?
    let expiresAt: String?

    enum CodingKeys: String, CodingKey {
        case id, status, key
        case activationLimit = "activation_limit"
        case activationUsage = "activation_usage"
        case createdAt = "created_at"
        case expiresAt = "expires_at"
    }

    var isActive: Bool {
        status == "active"
    }
}

struct LicenseMeta: Codable {
    let storeId: Int
    let orderId: Int
    let orderItemId: Int
    let productId: Int
    let productName: String
    let variantId: Int
    let variantName: String
    let customerName: String
    let customerEmail: String

    enum CodingKeys: String, CodingKey {
        case storeId = "store_id"
        case orderId = "order_id"
        case orderItemId = "order_item_id"
        case productId = "product_id"
        case productName = "product_name"
        case variantId = "variant_id"
        case variantName = "variant_name"
        case customerName = "customer_name"
        case customerEmail = "customer_email"
    }
}
