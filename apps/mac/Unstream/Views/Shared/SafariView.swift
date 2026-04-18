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

/// Wrapper to make URL identifiable for sheet presentation
struct SafariURL: Identifiable {
    let id = UUID()
    let url: URL
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
#endif