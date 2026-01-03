import Foundation
import SwiftUI

@MainActor
class LicenseManager: ObservableObject {
    // Your LemonSqueezy store ID - used to verify license is for this product
    private let expectedStoreId = 188119

    // Stored license data
    @AppStorage("licenseKey") var licenseKey: String = ""
    @AppStorage("licenseValidatedAt") private var licenseValidatedAt: Double = 0
    @AppStorage("licenseIsValid") private var storedLicenseIsValid: Bool = false
    @AppStorage("licenseEmail") private var licenseEmail: String = ""

    // Published state for UI
    @Published var isValidating: Bool = false
    @Published var validationError: String? = nil

    // Revalidation interval: 7 days
    private let revalidationInterval: TimeInterval = 7 * 24 * 60 * 60

    // LemonSqueezy License API endpoint
    private let licenseAPIURL = "https://api.lemonsqueezy.com/v1/licenses/validate"

    var isPro: Bool {
        // Must have a license key and it must be valid
        guard !licenseKey.isEmpty else { return false }

        // Check if we have a valid cached result
        if storedLicenseIsValid {
            // Check if revalidation is needed
            let lastValidated = Date(timeIntervalSince1970: licenseValidatedAt)
            let needsRevalidation = Date().timeIntervalSince(lastValidated) > revalidationInterval

            if needsRevalidation {
                // Trigger background revalidation but still return cached status
                Task {
                    await validateLicense()
                }
            }
            return true
        }

        return false
    }

    var customerEmail: String? {
        licenseEmail.isEmpty ? nil : licenseEmail
    }

    func validateLicense() async {
        await validateLicense(key: licenseKey)
    }

    func validateLicense(key: String) async {
        let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedKey.isEmpty else {
            validationError = "Please enter a license key"
            return
        }

        isValidating = true
        validationError = nil

        do {
            let response = try await callLemonSqueezyAPI(licenseKey: trimmedKey)

            if response.valid,
               let licenseInfo = response.licenseKey,
               let meta = response.meta {

                // Security check: verify this license is for our store
                guard meta.storeId == expectedStoreId else {
                    validationError = "Invalid license key"
                    storedLicenseIsValid = false
                    isValidating = false
                    return
                }

                // Check license status
                guard licenseInfo.isActive else {
                    validationError = "License is \(licenseInfo.status)"
                    storedLicenseIsValid = false
                    isValidating = false
                    return
                }

                // Success! Store the validated license
                licenseKey = trimmedKey
                storedLicenseIsValid = true
                licenseValidatedAt = Date().timeIntervalSince1970
                licenseEmail = meta.customerEmail
                validationError = nil

            } else {
                validationError = response.error ?? "Invalid license key"
                storedLicenseIsValid = false
            }

        } catch {
            print("License validation error: \(error)")
            // On network error, keep existing valid status if we have one
            if !storedLicenseIsValid {
                validationError = "Could not validate license. Check your internet connection."
            }
        }

        isValidating = false
    }

    func clearLicense() {
        licenseKey = ""
        storedLicenseIsValid = false
        licenseValidatedAt = 0
        licenseEmail = ""
        validationError = nil
    }

    private func callLemonSqueezyAPI(licenseKey: String) async throws -> LicenseResponse {
        guard let url = URL(string: licenseAPIURL) else {
            throw LicenseError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let body = "license_key=\(licenseKey)"
        request.httpBody = body.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw LicenseError.requestFailed
        }

        // LemonSqueezy returns 200 even for invalid keys, with valid=false in body
        guard (200...299).contains(httpResponse.statusCode) else {
            throw LicenseError.requestFailed
        }

        let decoder = JSONDecoder()
        return try decoder.decode(LicenseResponse.self, from: data)
    }

    enum LicenseError: Error {
        case invalidURL
        case requestFailed
        case invalidResponse
    }
}
