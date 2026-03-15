import Foundation
import AppKit
import Carbon.HIToolbox

/// Represents a keyboard shortcut with modifier flags and a key code
struct HotkeyShortcut: Codable, Equatable {
    let keyCode: UInt16
    let modifierFlags: UInt  // NSEvent.ModifierFlags.rawValue

    var modifiers: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: modifierFlags)
    }

    /// Human-readable display string (e.g. "⌘⇧K")
    var displayString: String {
        var parts: [String] = []
        if modifiers.contains(.control) { parts.append("⌃") }
        if modifiers.contains(.option) { parts.append("⌥") }
        if modifiers.contains(.shift) { parts.append("⇧") }
        if modifiers.contains(.command) { parts.append("⌘") }
        parts.append(keyCodeToString(keyCode))
        return parts.joined()
    }

    /// Convert NSEvent modifier flags to Carbon modifier flags
    var carbonModifiers: UInt32 {
        var carbonMods: UInt32 = 0
        if modifiers.contains(.command) { carbonMods |= UInt32(cmdKey) }
        if modifiers.contains(.option) { carbonMods |= UInt32(optionKey) }
        if modifiers.contains(.control) { carbonMods |= UInt32(controlKey) }
        if modifiers.contains(.shift) { carbonMods |= UInt32(shiftKey) }
        return carbonMods
    }
}

// MARK: - Carbon Hotkey Handler

/// Global C callback for Carbon hotkey events.
/// Must be a free function (not a closure) for Carbon interop.
private func carbonHotkeyHandler(
    nextHandler: EventHandlerCallRef?,
    event: EventRef?,
    userData: UnsafeMutableRawPointer?
) -> OSStatus {
    Task { @MainActor in
        AppDelegate.shared?.togglePopover()
    }
    return noErr
}

/// Manages global keyboard shortcut registration using Carbon RegisterEventHotKey.
/// This is the standard macOS approach used by Alfred, Raycast, etc.
/// Unlike NSEvent.addGlobalMonitorForEvents, it does NOT require Accessibility permission.
@MainActor
class GlobalHotkeyManager: ObservableObject {
    static let shared = GlobalHotkeyManager()

    @Published var currentShortcut: HotkeyShortcut? {
        didSet { saveShortcut() }
    }
    @Published var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: "globalHotkeyEnabled")
            if isEnabled {
                registerHotkey()
            } else {
                unregisterHotkey()
            }
        }
    }
    private var hotkeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?
    private let hotkeyID = EventHotKeyID(signature: OSType(0x554E5354), id: 1) // "UNST"

    private init() {
        isEnabled = UserDefaults.standard.object(forKey: "globalHotkeyEnabled") as? Bool ?? false
        loadShortcut()

        // Install the Carbon event handler once
        installCarbonHandler()

        if isEnabled && currentShortcut != nil {
            registerHotkey()
        }
    }

    private func installCarbonHandler() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(
            GetApplicationEventTarget(),
            carbonHotkeyHandler,
            1,
            &eventType,
            nil,
            &eventHandlerRef
        )
    }

    func registerHotkey() {
        unregisterHotkey()
        guard let shortcut = currentShortcut, isEnabled else { return }

        var hotkeyIDCopy = hotkeyID
        let status = RegisterEventHotKey(
            UInt32(shortcut.keyCode),
            shortcut.carbonModifiers,
            hotkeyIDCopy,
            GetApplicationEventTarget(),
            0,
            &hotkeyRef
        )

        if status != noErr {
            print("[GlobalHotkey] Failed to register hotkey: \(status)")
        } else {
            print("[GlobalHotkey] Registered: \(shortcut.displayString)")
        }
    }

    func unregisterHotkey() {
        if let ref = hotkeyRef {
            UnregisterEventHotKey(ref)
            hotkeyRef = nil
        }
    }

    private func saveShortcut() {
        if let shortcut = currentShortcut,
           let data = try? JSONEncoder().encode(shortcut) {
            UserDefaults.standard.set(data, forKey: "globalHotkeyShortcut")
        } else {
            UserDefaults.standard.removeObject(forKey: "globalHotkeyShortcut")
        }
    }

    private func loadShortcut() {
        if let data = UserDefaults.standard.data(forKey: "globalHotkeyShortcut"),
           let shortcut = try? JSONDecoder().decode(HotkeyShortcut.self, from: data) {
            currentShortcut = shortcut
        }
    }

    nonisolated deinit {
        // Note: hotkeyRef and eventHandlerRef are cleaned up by the OS on process exit
        // since this is a singleton that lives for the app's lifetime
    }
}

// MARK: - Key Code to String Mapping

/// Converts a virtual key code to a human-readable string
func keyCodeToString(_ keyCode: UInt16) -> String {
    switch Int(keyCode) {
    case kVK_ANSI_A: return "A"
    case kVK_ANSI_B: return "B"
    case kVK_ANSI_C: return "C"
    case kVK_ANSI_D: return "D"
    case kVK_ANSI_E: return "E"
    case kVK_ANSI_F: return "F"
    case kVK_ANSI_G: return "G"
    case kVK_ANSI_H: return "H"
    case kVK_ANSI_I: return "I"
    case kVK_ANSI_J: return "J"
    case kVK_ANSI_K: return "K"
    case kVK_ANSI_L: return "L"
    case kVK_ANSI_M: return "M"
    case kVK_ANSI_N: return "N"
    case kVK_ANSI_O: return "O"
    case kVK_ANSI_P: return "P"
    case kVK_ANSI_Q: return "Q"
    case kVK_ANSI_R: return "R"
    case kVK_ANSI_S: return "S"
    case kVK_ANSI_T: return "T"
    case kVK_ANSI_U: return "U"
    case kVK_ANSI_V: return "V"
    case kVK_ANSI_W: return "W"
    case kVK_ANSI_X: return "X"
    case kVK_ANSI_Y: return "Y"
    case kVK_ANSI_Z: return "Z"
    case kVK_ANSI_0: return "0"
    case kVK_ANSI_1: return "1"
    case kVK_ANSI_2: return "2"
    case kVK_ANSI_3: return "3"
    case kVK_ANSI_4: return "4"
    case kVK_ANSI_5: return "5"
    case kVK_ANSI_6: return "6"
    case kVK_ANSI_7: return "7"
    case kVK_ANSI_8: return "8"
    case kVK_ANSI_9: return "9"
    case kVK_ANSI_Minus: return "-"
    case kVK_ANSI_Equal: return "="
    case kVK_ANSI_LeftBracket: return "["
    case kVK_ANSI_RightBracket: return "]"
    case kVK_ANSI_Backslash: return "\\"
    case kVK_ANSI_Semicolon: return ";"
    case kVK_ANSI_Quote: return "'"
    case kVK_ANSI_Comma: return ","
    case kVK_ANSI_Period: return "."
    case kVK_ANSI_Slash: return "/"
    case kVK_ANSI_Grave: return "`"
    case kVK_Space: return "Space"
    case kVK_Return: return "↩"
    case kVK_Tab: return "⇥"
    case kVK_Delete: return "⌫"
    case kVK_Escape: return "⎋"
    case kVK_F1: return "F1"
    case kVK_F2: return "F2"
    case kVK_F3: return "F3"
    case kVK_F4: return "F4"
    case kVK_F5: return "F5"
    case kVK_F6: return "F6"
    case kVK_F7: return "F7"
    case kVK_F8: return "F8"
    case kVK_F9: return "F9"
    case kVK_F10: return "F10"
    case kVK_F11: return "F11"
    case kVK_F12: return "F12"
    case kVK_LeftArrow: return "←"
    case kVK_RightArrow: return "→"
    case kVK_UpArrow: return "↑"
    case kVK_DownArrow: return "↓"
    default: return "?"
    }
}

/// Validates that a key event has at least one modifier key (Command, Control, Option)
/// Shift alone is not sufficient — it must be combined with another modifier
func isValidShortcutEvent(_ event: NSEvent) -> Bool {
    let mods = event.modifierFlags
    let hasCommand = mods.contains(.command)
    let hasControl = mods.contains(.control)
    let hasOption = mods.contains(.option)
    return hasCommand || hasControl || hasOption
}
