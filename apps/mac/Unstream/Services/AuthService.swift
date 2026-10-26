import Foundation
import os
import Supabase

/// Manages Supabase auth state for the Unstream app.
/// Uses the SDK's built-in keychain storage for session tokens.
/// The anon key is public by design — RLS policies control access.
@MainActor
class AuthService: ObservableObject {

    static let shared = AuthService()

    private static let logger = Logger(subsystem: "lol.bgreen.Unstream", category: "auth")

    // Public anon key — safe to embed, RLS is the real gatekeeper.
    private let supabaseURL = URL(string: "https://bwogclqzpsbvqbyhhqbz.supabase.co")!

    let client: SupabaseClient

    @Published var session: Session?
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?
    @Published var magicLinkSent: Bool = false

    private init() {
        let anonKey = Bundle.main.infoDictionary?["SUPABASE_ANON_KEY"] as? String ?? ""
        client = SupabaseClient(
            supabaseURL: supabaseURL,
            supabaseKey: anonKey,
            options: SupabaseClientOptions(global: .init(logger: AuthLogger()))
        )

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
                // The stored access token has usually expired by launch (the SDK only refreshes
                // while the app is active), so this is a network call. Signing out on any failure
                // turned a launch with the network not yet up — after an update, at login — into
                // a sign-out. Only a session the server has rejected is over; otherwise keep it,
                // and currentAccessToken() refreshes it on the next request.
                Self.logger.error("Session refresh at launch failed: \(error.localizedDescription, privacy: .public)")
                if Self.refreshRejectsSession(error) {
                    session = nil
                }
            }
        }
    }

    /// Whether a failed refresh means the session is over, as opposed to the server not being
    /// reachable. Only the server saying no (a 4xx other than rate limiting) or no stored session
    /// at all ends it; a timeout, a dropped connection or a 5xx is worth trying again.
    nonisolated static func refreshRejectsSession(_ error: Error) -> Bool {
        switch error {
        case AuthError.sessionMissing:
            return true
        case let AuthError.api(_, _, _, response):
            return (400..<500).contains(response.statusCode) && response.statusCode != 429
        default:
            return false
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
        SavedArtistsSync.shared.reset()
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
        do {
            let validSession = try await client.auth.session
            session = validSession
            return validSession.accessToken
        } catch {
            if Self.refreshRejectsSession(error) {
                Self.logger.error("Session rejected on refresh: \(error.localizedDescription, privacy: .public)")
                session = nil
            }
            throw error
        }
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

/// Sends the Supabase SDK's warnings and errors to the unified log (`log show --predicate
/// 'subsystem == "lol.bgreen.Unstream"'`). Without a logger the SDK drops them, and a keychain read
/// or write that failed looked exactly like being signed out. Only the message is logged: the SDK's
/// additionalContext can carry the refresh token. A message quoting a URL stays private (redacted),
/// because the one the SDK quotes is the magic-link callback, and that URL holds the sign-in tokens.
private struct AuthLogger: SupabaseLogger {
    private let logger = Logger(subsystem: "lol.bgreen.Unstream", category: "supabase")

    func log(message: SupabaseLogMessage) {
        let type: OSLogType
        switch message.level {
        case .error: type = .error
        case .warning: type = .default
        case .verbose, .debug: return
        }
        if message.message.contains("://") {
            logger.log(level: type, "\(message.system, privacy: .public): \(message.message, privacy: .private)")
        } else {
            logger.log(level: type, "\(message.system, privacy: .public): \(message.message, privacy: .public)")
        }
    }
}
