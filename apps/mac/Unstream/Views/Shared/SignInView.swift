import SwiftUI

/// Sign-in sheet for email/password + magic link.
/// Shared between macOS menu bar popover and iOS settings tab.
struct SignInView: View {
    @ObservedObject var auth = AuthService.shared
    @Environment(\.dismiss) var dismiss

    @State private var email = ""
    @State private var password = ""
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
                    #if os(iOS)
                    .autocapitalization(.none)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    #endif

                SecureField("Password", text: $password)
                    .textFieldStyle(.roundedBorder)
                    #if os(iOS)
                    .textContentType(.password)
                    #endif
            }

            // Error message
            if let error = auth.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
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

                Text("A sign-in window will open — complete the steps there to continue.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)

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

            // A magic link creates an account when there isn't one, and this sheet also has an
            // explicit Create Account button — so the consent line belongs here, matching the
            // web app's LegalConsent component word for word.
            Text("By continuing you agree to Unstream's [Terms of Use](https://unstream.stream/terms) and [Privacy Policy](https://unstream.stream/privacy-policy).")
                .font(.caption2)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
        .padding()
        .frame(maxWidth: 320)
        .onAppear {
            auth.errorMessage = nil
        }
    }

    private func signIn() {
        Task {
            await auth.signInWithEmail(email: email, password: password)
            if auth.isSignedIn {
                dismiss()
            }
        }
    }

    private func signUp() {
        Task {
            await auth.signUpWithEmail(email: email, password: password)
        }
    }

    private func sendMagicLink() {
        auth.sendMagicLink(email: email)
    }

    private func toggleSignUp() {
        showSignUp.toggle()
        auth.errorMessage = nil
    }
}
