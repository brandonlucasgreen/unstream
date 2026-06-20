import Foundation
import Supabase

/// Manages Supabase auth state for the Unstream app.
/// Uses the SDK's built-in keychain storage for session tokens.
/// The anon key is public by design — RLS policies control access.
@MainActor
class AuthService: ObservableObject {

    static let shared = AuthService()

    // Public anon key — safe to embed, RLS is the real gatekeeper.
    private let supabaseURL = URL(string: "https://bwogclqzpsbvqbyhhqbz.supabase.co")!
    private var supabaseAnonKey: String {
        Bundle.main.infoDictionary?["SUPABASE_ANON_KEY"] as? String ?? ""
    }

    let client: SupabaseClient

    @Published var session: Session?
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?

    private init() {
        let anonKey = Bundle.main.infoDictionary?["SUPABASE_ANON_KEY"] as? String ?? ""
        client = SupabaseClient(supabaseURL: supabaseURL, supabaseKey: anonKey)

        Task {
            migrateOldKeychainTokens()
            await restoreSession()
        }
    }

    var isSignedIn: Bool {
        session != nil
    }

    var userEmail: String? {
        session?.user.email
    }

    // MARK: - Session restore

    func restoreSession() async {
        // Use currentSession for non-throwing access to stored session
        session = client.auth.currentSession

        // If we have a session, try to validate/refresh it
        if session != nil {
            do {
                let validSession = try await client.auth.session
                session = validSession
            } catch {
                // Session expired and couldn't be refreshed
                session = nil
            }
        }
    }

    // MARK: - Email/Password

    func signInWithEmail(email: String, password: String) async {
        isLoading = true
        errorMessage = nil

        do {
            let result = try await client.auth.signIn(email: email, password: password)
            session = result
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    func signUpWithEmail(email: String, password: String) async {
        isLoading = true
        errorMessage = nil

        do {
            let response = try await client.auth.signUp(email: email, password: password)
            if let newSession = response.session {
                session = newSession
            } else {
                // Email confirmation required
                errorMessage = "Check your email to confirm your account."
            }
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    // MARK: - Magic Link

    func sendMagicLink(email: String) async {
        isLoading = true
        errorMessage = nil

        do {
            try await client.auth.signInWithOTP(
                email: email,
                redirectTo: URL(string: "unstream://auth/callback")
            )
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    // MARK: - Deeplink handling

    /// Handle the callback URL from a custom URL scheme deeplink.
    /// The URL contains the auth tokens as query/hash params; PKCE code-verifier
    /// validates the token contents.
    func handleAuthCallback(url: URL) async {
        isLoading = true
        errorMessage = nil

        do {
            let result = try await client.auth.session(from: url)
            session = result
        } catch {
            errorMessage = "Sign-in failed: \(error.localizedDescription)"
        }

        isLoading = false
    }

    // MARK: - Sign Out

    func signOut() async {
        do {
            try await client.auth.signOut()
        } catch {
            // Best effort — clear local state regardless
        }
        session = nil
    }

    // MARK: - Access token

    var accessToken: String? {
        session?.accessToken
    }

    // MARK: - Refresh-aware token access

    /// Returns a valid access token, refreshing the session if needed.
    /// Use this instead of `accessToken` for network calls.
    func currentAccessToken() async throws -> String? {
        guard session != nil else { return nil }
        let validSession = try await client.auth.session
        session = validSession
        return validSession.accessToken
    }

    // MARK: - Keychain migration

    /// One-time migration: if auth tokens were previously stored via KeychainHelper
    /// (service `lol.bgreen.Unstream`), the SDK now manages its own keychain storage.
    /// This is a no-op for new installs but handles upgrades from pre-sync builds.
    private func migrateOldKeychainTokens() {
        let migrationFlag = "supabase_keychain_migrated"
        guard !UserDefaults.standard.bool(forKey: migrationFlag) else { return }

        // Check if there's a Supabase access token stored in the old keychain helper
        // (only relevant if a previous build stored it there — currently none do)
        let oldTokenKey = "supabase_access_token"
        if let _ = KeychainHelper.load(key: oldTokenKey) {
            // The SDK's session restore will pick up tokens from its own keychain storage.
            // If we find a token in the old location, clean it up — the SDK can't use it
            // directly, but we log for debugging.
            print("[AuthService] Found old Supabase token in KeychainHelper — SDK manages its own storage.")
            KeychainHelper.delete(key: oldTokenKey)
        }

        UserDefaults.standard.set(true, forKey: migrationFlag)
    }
}
