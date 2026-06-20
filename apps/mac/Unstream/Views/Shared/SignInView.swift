import SwiftUI

/// Sign-in sheet for email/password + magic link.
/// Shared between macOS menu bar popover and iOS settings tab.
struct SignInView: View {
    @ObservedObject var auth = AuthService.shared
    @Environment(\.dismiss) var dismiss

    @State private var email = ""
    @State private var password = ""
    @State private var magicLinkSent = false
    @State private var showSignUp = false

    var body: some View {
        VStack(spacing: 16) {
            // Header
            VStack(spacing: 4) {
                Image(systemName: "music.note")
                    .font(.system(size: 32))
                    .foregroundColor(.accentColor)

                Text("Sign in to Unstream")
                    .font(.headline)

                Text("Sync your saved artists across devices.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }

            // Email + password fields
            VStack(spacing: 10) {
                TextField("Email", text: $email)
                    .textFieldStyle(.roundedBorder)
                    .autocapitalization(.none)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)

                SecureField("Password", text: $password)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.password)
            }

            // Error message
            if let error = auth.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }

            // Magic link sent confirmation
            if magicLinkSent {
                HStack(spacing: 6) {
                    Image(systemName: "envelope.badge")
                        .foregroundColor(.green)
                    Text("Magic link sent! Check your email.")
                        .font(.caption)
                        .foregroundColor(.green)
                }
            }

            // Buttons
            VStack(spacing: 8) {
                Button(action: signIn) {
                    HStack {
                        if auth.isLoading {
                            ProgressView()
                                .scaleEffect(0.7)
                        }
                        Text("Sign In")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(email.isEmpty || password.isEmpty || auth.isLoading)

                Button(action: sendMagicLink) {
                    Text("Send Magic Link")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(email.isEmpty || auth.isLoading)

                Button(action: toggleSignUp) {
                    Text(showSignUp ? "Already have an account? Sign In" : "Need an account? Sign Up")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundColor(.accentColor)
            }

            if showSignUp {
                Button(action: signUp) {
                    HStack {
                        if auth.isLoading {
                            ProgressView()
                                .scaleEffect(0.7)
                        }
                        Text("Create Account")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(email.isEmpty || password.isEmpty || auth.isLoading)
            }
        }
        .padding()
        .frame(maxWidth: 320)
    }

    private func signIn() {
        magicLinkSent = false
        Task {
            await auth.signInWithEmail(email: email, password: password)
            if auth.isSignedIn {
                dismiss()
            }
        }
    }

    private func signUp() {
        magicLinkSent = false
        Task {
            await auth.signUpWithEmail(email: email, password: password)
        }
    }

    private func sendMagicLink() {
        Task {
            await auth.sendMagicLink(email: email)
            if auth.errorMessage == nil {
                magicLinkSent = true
            }
        }
    }

    private func toggleSignUp() {
        showSignUp.toggle()
        magicLinkSent = false
        auth.errorMessage = nil
    }
}
