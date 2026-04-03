import Foundation
import Security

/// Helper for storing and retrieving sensitive tokens in the macOS Keychain.
/// Used instead of UserDefaults for credentials that grant broad access (e.g. Plex tokens).
enum KeychainHelper {

    /// Save a string value to the Keychain under the given key.
    /// Overwrites any existing value for the same key.
    @discardableResult
    static func save(key: String, value: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }

        // Delete any existing item first to avoid errSecDuplicateItem
        delete(key: key)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "stream.unstream.mac",
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            print("[KeychainHelper] Save failed for '\(key)': \(status)")
        }
        return status == errSecSuccess
    }

    /// Load a string value from the Keychain for the given key.
    /// Returns nil if the key is not found or if an error occurs.
    static func load(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "stream.unstream.mac",
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else {
            if status != errSecItemNotFound {
                print("[KeychainHelper] Load failed for '\(key)': \(status)")
            }
            return nil
        }

        return String(data: data, encoding: .utf8)
    }

    /// Delete the value stored under the given key.
    @discardableResult
    static func delete(key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "stream.unstream.mac",
            kSecAttrAccount as String: key
        ]

        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            print("[KeychainHelper] Delete failed for '\(key)': \(status)")
        }
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
