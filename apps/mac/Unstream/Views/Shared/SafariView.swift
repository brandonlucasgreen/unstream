#if os(iOS)
import SwiftUI
import SafariServices

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.dismissButtonStyle = .close
        return controller
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {
        // No updates needed
    }
}

/// Wrapper to make URL identifiable for sheet presentation.
/// Only http/https URLs are accepted — SFSafariViewController crashes on other schemes.
struct SafariURL: Identifiable {
    let id = UUID()
    let url: URL

    init?(url: URL) {
        guard url.scheme == "http" || url.scheme == "https" else { return nil }
        self.url = url
    }
}

/// Modifier that presents an in-app Safari sheet when a URL is set.
struct SafariSheetModifier: ViewModifier {
    @Binding var safariItem: SafariURL?

    func body(content: Content) -> some View {
        content.sheet(item: $safariItem) { item in
            SafariView(url: item.url)
                .ignoresSafeArea()
        }
    }
}

extension View {
    func safariSheet(safariItem: Binding<SafariURL?>) -> some View {
        modifier(SafariSheetModifier(safariItem: safariItem))
    }
}
#endif