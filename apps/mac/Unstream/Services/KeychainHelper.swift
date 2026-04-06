import Foundation
import Security

/// Helper for storing and retrieving sensitive tokens in the macOS Keychain.
/// Used instead of UserDefaults for credentials that grant broad access (e.g. Plex tokens).
enum KeychainHelper {

    private static let serviceName = "lol.bgreen.Unstream"
    private static let oldServiceName = "stream.unstream.mac"
    private static let migrationFlag = "keychainServiceMigrated"

    /// Save a string value to the Keychain under the given key.
    /// Overwrites any existing value for the same key.
    @discardableResult
    static func save(key: String, value: String) -> Bool {
        migrateIfNeeded(key: key)

        guard let data = value.data(using: .utf8) else { return false }

        // Delete any existing item first to avoid errSecDuplicateItem
        delete(key: key)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
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
        migrateIfNeeded(key: key)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
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
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key
        ]

        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            print("[KeychainHelper] Delete failed for '\(key)': \(status)")
        }
        return status == errSecSuccess || status == errSecItemNotFound
    }

    // MARK: - Migration from old service name

    /// Migrate a keychain item from the old service name to the new one, if needed.
    /// Only runs once per app lifetime, gated by a UserDefaults flag.
    private static func migrateIfNeeded(key: String) {
        guard !UserDefaults.standard.bool(forKey: migrationFlag) else { return }

        // Try to read from the old service name
        let oldQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: oldServiceName,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(oldQuery as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else {
            // No old item found for this key — mark migration done
            UserDefaults.standard.set(true, forKey: migrationFlag)
            return
        }

        // Copy to new service name
        let newQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked
        ]

        // Delete any existing new item first
        let deleteNewQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(deleteNewQuery as CFDictionary)

        let addStatus = SecItemAdd(newQuery as CFDictionary, nil)
        if addStatus == errSecSuccess {
            // Delete from old service name
            let deleteOldQuery: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: oldServiceName,
                kSecAttrAccount as String: key
            ]
            SecItemDelete(deleteOldQuery as CFDictionary)
            print("[KeychainHelper] Migrated '\(key)' from old service name")
        } else {
            print("[KeychainHelper] Migration failed for '\(key)': \(addStatus)")
        }

        UserDefaults.standard.set(true, forKey: migrationFlag)
    }
}
