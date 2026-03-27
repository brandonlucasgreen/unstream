import SwiftUI
import AppKit
import Carbon.HIToolbox

/// Manages a local key event monitor for recording keyboard shortcuts.
/// Uses NSEvent.addLocalMonitorForEvents which reliably captures all key
/// events within the app — no first-responder juggling required.
class ShortcutRecorder: ObservableObject {
    @Published var isRecording = false
    private var monitor: Any?

    var onShortcutCaptured: ((HotkeyShortcut) -> Void)?
    var onCancel: (() -> Void)?

    func startRecording() {
        stopRecording()
        isRecording = true

        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }

            // Escape cancels
            if event.keyCode == UInt16(kVK_Escape) {
                self.stopRecording()
                self.onCancel?()
                return nil // swallow the event
            }

            // Ignore bare modifier keys (no character key pressed yet)
            if self.isModifierOnlyKeyCode(event.keyCode) {
                return nil
            }

            // Must have at least one of Command, Control, or Option
            guard isValidShortcutEvent(event) else { return nil }

            let relevantFlags: NSEvent.ModifierFlags = [.command, .control, .option, .shift]
            let shortcut = HotkeyShortcut(
                keyCode: event.keyCode,
                modifierFlags: event.modifierFlags.intersection(relevantFlags).rawValue
            )

            self.stopRecording()
            self.onShortcutCaptured?(shortcut)
            return nil // swallow the event
        }
    }

    func stopRecording() {
        if let monitor = monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
        isRecording = false
    }

    private func isModifierOnlyKeyCode(_ keyCode: UInt16) -> Bool {
        switch Int(keyCode) {
        case kVK_Shift, kVK_RightShift,
             kVK_Command, kVK_RightCommand,
             kVK_Option, kVK_RightOption,
             kVK_Control, kVK_RightControl,
             kVK_CapsLock, kVK_Function:
            return true
        default:
            return false
        }
    }

    deinit {
        stopRecording()
    }
}
