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

    // LemonSqueezy License API endpoints
    private let activateAPIURL = "https://api.lemonsqueezy.com/v1/licenses/activate"
    private let validateAPIURL = "https://api.lemonsqueezy.com/v1/licenses/validate"

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
            // First try to activate the license (for new licenses)
            var response = try await activateLicense(licenseKey: trimmedKey)

            // If activation says already activated or limit reached, try validate instead
            if !response.isSuccess && (response.error?.contains("activated") == true || response.error?.contains("limit") == true) {
                print("License already activated, trying validate...")
                response = try await validateLicenseAPI(licenseKey: trimmedKey)
            }

            if response.isSuccess,
               let licenseInfo = response.licenseKey,
               let meta = response.meta {

                // Security check: verify this license is for our store
                guard meta.storeId == expectedStoreId else {
                    validationError = "Invalid license key"
                    storedLicenseIsValid = false
                    isValidating = false
                    return
                }

                // Success! Store the validated license
                licenseKey = trimmedKey
                storedLicenseIsValid = true
                licenseValidatedAt = Date().timeIntervalSince1970
                licenseEmail = meta.customerEmail ?? ""
                validationError = nil

            } else {
                validationError = response.error ?? "Invalid license key"
                storedLicenseIsValid = false
            }

        } catch let decodingError as DecodingError {
            print("License JSON decoding error: \(decodingError)")
            if case .keyNotFound(let key, let context) = decodingError {
                print("Missing key: \(key.stringValue) at \(context.codingPath)")
            }
            if case .typeMismatch(let type, let context) = decodingError {
                print("Type mismatch: expected \(type) at \(context.codingPath)")
            }
            validationError = "License validation failed. Please try again."
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

    private func activateLicense(licenseKey: String) async throws -> LicenseResponse {
        guard let url = URL(string: activateAPIURL) else {
            throw LicenseError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let encodedKey = licenseKey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? licenseKey
        let instanceName = Host.current().localizedName ?? "Mac"
        let body = "license_key=\(encodedKey)&instance_name=\(instanceName)"
        request.httpBody = body.data(using: .utf8)
        print("Activating license key: \(licenseKey.prefix(8))... on \(instanceName)")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw LicenseError.requestFailed
        }

        print("LemonSqueezy activate response status: \(httpResponse.statusCode)")
        if let responseString = String(data: data, encoding: .utf8) {
            print("LemonSqueezy activate response body: \(responseString)")
        }

        guard (200...299).contains(httpResponse.statusCode) || httpResponse.statusCode == 400 || httpResponse.statusCode == 404 else {
            throw LicenseError.requestFailed
        }

        let decoder = JSONDecoder()
        return try decoder.decode(LicenseResponse.self, from: data)
    }

    private func validateLicenseAPI(licenseKey: String) async throws -> LicenseResponse {
        guard let url = URL(string: validateAPIURL) else {
            throw LicenseError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let encodedKey = licenseKey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? licenseKey
        let body = "license_key=\(encodedKey)"
        request.httpBody = body.data(using: .utf8)
        print("Validating license key: \(licenseKey.prefix(8))...")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw LicenseError.requestFailed
        }

        print("LemonSqueezy validate response status: \(httpResponse.statusCode)")
        if let responseString = String(data: data, encoding: .utf8) {
            print("LemonSqueezy validate response body: \(responseString)")
        }

        guard (200...299).contains(httpResponse.statusCode) || httpResponse.statusCode == 404 else {
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
