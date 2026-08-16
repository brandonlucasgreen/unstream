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

    let client: SupabaseClient

    @Published var session: Session?
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?
    @Published var magicLinkSent: Bool = false

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

    /// Sends a magic-link sign-in email via Supabase's OTP endpoint.
    ///
    /// The email links to `unstream://auth/callback`. There's no interactive
    /// window to wait on here — the user opens the email in their own time,
    /// possibly on a different device, so this only confirms the email was
    /// sent. The app's URL-scheme handling (`onOpenURL` in `UnstreamApp`)
    /// hands the resulting callback URL to `handleAuthCallback` below.
    func sendMagicLink(email: String) {
        isLoading = true
        errorMessage = nil
        magicLinkSent = false

        Task {
            do {
                try await client.auth.signInWithOTP(
                    email: email,
                    redirectTo: URL(string: "unstream://auth/callback")!
                )
                magicLinkSent = true
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }

    #if os(macOS)
    /// Resets loading state when the popover closes, so a slow magic-link
    /// request doesn't leave the sign-in sheet stuck locked next time it opens.
    func cancelPendingAuth() {
        if isLoading {
            isLoading = false
            errorMessage = nil
        }
    }
    #endif

    // MARK: - Deeplink handling

    /// Completes a magic-link sign-in from the `unstream://auth/callback` URL
    /// the browser opens after the user clicks the emailed link. The SDK
    /// validates the token (or PKCE code) contained in the URL.
    func handleAuthCallback(url: URL) async {
        isLoading = true
        errorMessage = nil

        do {
            let result = try await client.auth.session(from: url)
            session = result
            magicLinkSent = false
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
