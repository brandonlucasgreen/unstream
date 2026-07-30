import SwiftUI

struct SearchBarView: View {
    @EnvironmentObject var appState: AppState
    /// Owned by PopoverView so it can focus the field on open and on ⌘F.
    @FocusState.Binding var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.secondary)
                .accessibilityHidden(true)

            TextField("Search for artists…", text: $appState.searchQuery)
                .textFieldStyle(.plain)
                .focused($isFocused)
                .accessibilityLabel("Search for artists")
                .onSubmit {
                    Task {
                        await appState.performSearch()
                    }
                }

            if !appState.searchQuery.isEmpty {
                Button(action: {
                    appState.clearSearch()
                    isFocused = true
                }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
                .help("Clear search")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(NSColor.textBackgroundColor))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Color(NSColor.separatorColor), lineWidth: 1)
                )
        )
    }
}

private struct SearchBarPreviewContainer: View {
    @FocusState private var focused: Bool

    var body: some View {
        SearchBarView(isFocused: $focused)
            .environmentObject(AppState())
            .padding()
    }
}

#Preview {
    SearchBarPreviewContainer()
}
