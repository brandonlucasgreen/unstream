import Foundation

/// Manages a stable per-installation device ID stored in keychain.
/// Used for cross-client sync so the server can track which device made a change.
enum DeviceIDManager {

    private static let key = "unstream_device_id"

    /// Returns the stable device ID, creating one if it doesn't exist yet.
    static let current: String = {
        if let existing = KeychainHelper.load(key: key) {
            return existing
        }
        let new = UUID().uuidString
        let saved = KeychainHelper.save(key: key, value: new)
        if !saved {
            print("[DeviceID] Failed to persist device ID to keychain — will regenerate on next launch")
        }
        return new
    }()
}
