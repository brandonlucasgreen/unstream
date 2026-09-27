import SwiftUI

/// "I'd tip them" and Play my city on a result row (docs/specs/artist-patronage-spec.md §3.5,
/// §3.6, §7). Native buttons calling the API with the fan's session — no web view.
///
/// macOS only: the spec keeps every patronage surface off iOS (App Review 3.2.1(vii)).
struct ArtistInterestButtons: View {
    let slug: String
    let artistName: String
    let interest: InterestCounts?

    @ObservedObject private var store = ArtistInterestStore.shared
    @ObservedObject private var auth = AuthService.shared

    @State private var showCityPopover = false
    @State private var showSignInPopover = false
    @State private var cityText = ""
    @State private var busy = false
    @State private var errorMessage: String?

    private var wouldTip: Bool { store.tip.contains(slug) }
    private var myCity: String? { store.cities[slug] }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Button(action: toggleTip) {
                    Label(wouldTip ? "You'd tip them" : "I'd tip them",
                          systemImage: wouldTip ? "checkmark.circle.fill" : "heart.circle")
                }
                .disabled(busy)
                .help("\(artistName) isn't taking tips on Unstream yet. Tell them you would — nothing is charged.")

                Button(action: openCity) {
                    Label(myCity.map { "Play \($0)" } ?? "Play my city",
                          systemImage: myCity == nil ? "mappin.circle" : "checkmark.circle.fill")
                }
                .popover(isPresented: $showCityPopover, arrowEdge: .bottom) { cityForm }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .popover(isPresented: $showSignInPopover, arrowEdge: .bottom) {
                Text("Sign in to Unstream in Settings to tell \(artistName).")
                    .font(.callout)
                    .padding(12)
                    .frame(width: 240)
            }

            if let summary = countsSummary {
                Text(summary)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundColor(.red)
            }
        }
        .task(id: auth.isSignedIn) {
            if auth.isSignedIn { await store.loadIfNeeded() }
        }
    }

    /// "14 fans would tip · Most wanted in Boston (12)". Counts arrive already thresholded.
    private var countsSummary: String? {
        var parts: [String] = []
        if let tipCount = interest?.tipCount, tipCount > 0 {
            parts.append("\(tipCount) fans would tip")
        }
        if let cities = interest?.cities, !cities.isEmpty {
            let list = cities.prefix(3).map { "\($0.label) (\($0.count))" }.joined(separator: ", ")
            parts.append("Most wanted in \(list)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var cityForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Where would you see \(artistName) play?")
                .font(.headline)
            TextField("Your city", text: $cityText)
                .textFieldStyle(.roundedBorder)
                .frame(width: 240)
                .onSubmit(saveCity)
            HStack {
                if myCity != nil {
                    Button("Remove", role: .destructive) { save(city: nil) }
                        .disabled(busy)
                }
                Spacer()
                Button("Cancel") { showCityPopover = false }
                    .keyboardShortcut(.cancelAction)
                Button("Ask \(artistName)", action: saveCity)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || cityText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(14)
    }

    private func toggleTip() {
        guard auth.isSignedIn else { showSignInPopover = true; return }
        busy = true
        errorMessage = nil
        Task {
            errorMessage = await store.setTip(slug: slug, on: !wouldTip)
            busy = false
        }
    }

    private func openCity() {
        guard auth.isSignedIn else { showSignInPopover = true; return }
        cityText = myCity ?? store.defaultCity ?? ""
        errorMessage = nil
        showCityPopover = true
    }

    private func saveCity() {
        let city = cityText.trimmingCharacters(in: .whitespaces)
        guard !city.isEmpty else { return }
        save(city: city)
    }

    private func save(city: String?) {
        busy = true
        Task {
            let error = await store.setCity(slug: slug, city: city)
            busy = false
            errorMessage = error
            if error == nil { showCityPopover = false }
        }
    }
}
