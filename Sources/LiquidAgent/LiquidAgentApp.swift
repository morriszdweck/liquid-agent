import AppKit
import SwiftUI

@main
struct LiquidAgentApp: App {
    @StateObject private var settings: AppSettings
    @StateObject private var memory: MemoryStore
    @StateObject private var voice: VoiceController
    @StateObject private var state: AppState

    init() {
        // Running via `swift run` has no bundle; make it a regular foreground app.
        NSApplication.shared.setActivationPolicy(.regular)
        let settings = AppSettings()
        let memory = MemoryStore()
        let voice = VoiceController()
        _settings = StateObject(wrappedValue: settings)
        _memory = StateObject(wrappedValue: memory)
        _voice = StateObject(wrappedValue: voice)
        _state = StateObject(wrappedValue: AppState(settings: settings, memory: memory, voice: voice))
    }

    var body: some Scene {
        WindowGroup("Liquid Agent") {
            ContentView()
                .environmentObject(state)
                .environmentObject(settings)
                .environmentObject(memory)
                .environmentObject(voice)
                .frame(minWidth: 820, minHeight: 560)
                .onAppear { NSApplication.shared.activate(ignoringOtherApps: true) }
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Chat") { state.newChat() }.keyboardShortcut("n")
            }
            CommandMenu("Agent") {
                Button("Stop") { state.stop() }.keyboardShortcut(".")
                Button("Voice Chat") { state.toggleVoiceChat() }.keyboardShortcut("v", modifiers: [.command, .shift])
                Divider()
                ForEach(ApprovalMode.allCases) { mode in
                    Button(mode.label) { settings.approvalMode = mode }
                }
            }
        }

        Settings {
            SettingsView()
                .environmentObject(settings)
                .environmentObject(memory)
        }
    }
}
