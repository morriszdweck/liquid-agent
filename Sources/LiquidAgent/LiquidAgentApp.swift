import AppKit
import SwiftUI

@main
struct LiquidAgentApp: App {
    @StateObject private var settings: AppSettings
    @StateObject private var memory: MemoryStore
    @StateObject private var voice: VoiceController
    @StateObject private var backends: Backends
    @StateObject private var state: AppState

    init() {
        if CommandLine.arguments.contains("--install") { HeadlessInstall.run() }
        if CommandLine.arguments.contains("--probe") { HeadlessInstall.probe() }
        // Running via `swift run` has no bundle; make it a regular foreground app.
        NSApplication.shared.setActivationPolicy(.regular)
        let settings = AppSettings()
        let memory = MemoryStore()
        let voice = VoiceController()
        let backends = Backends()
        _settings = StateObject(wrappedValue: settings)
        _memory = StateObject(wrappedValue: memory)
        _voice = StateObject(wrappedValue: voice)
        _backends = StateObject(wrappedValue: backends)
        _state = StateObject(wrappedValue: AppState(settings: settings, memory: memory, voice: voice, backends: backends))
    }

    var body: some Scene {
        WindowGroup("Liquid Agent") {
            ContentView()
                .environmentObject(state)
                .environmentObject(settings)
                .environmentObject(memory)
                .environmentObject(voice)
                .environmentObject(backends)
                .frame(minWidth: 900, minHeight: 600)
                .onAppear { NSApplication.shared.activate(ignoringOtherApps: true) }
                .task { await backends.startAll() }
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Chat") { state.newChat() }.keyboardShortcut("n")
            }
            CommandMenu("Agent") {
                Button("Voice Chat") { state.toggleVoiceChat() }.keyboardShortcut("v", modifiers: [.command, .shift])
                Button("Look at My Screen") { state.lookAtScreen() }.keyboardShortcut("l", modifiers: [.command, .shift])
                Button("Stop") { state.stop() }.keyboardShortcut(".")
                Divider()
                Button("For You") { state.screen = .forYou }.keyboardShortcut("1")
                Button("Routines") { state.screen = .routines }.keyboardShortcut("2")
                Button("Memory") { state.screen = .memory }.keyboardShortcut("3")
                Button("Activity") { state.screen = .activity }.keyboardShortcut("4")
                Button("Setup") { state.screen = .setup }
                Divider()
                ForEach(ApprovalMode.allCases) { mode in
                    Button(mode.label) { settings.approvalMode = mode }
                }
            }
        }

        MenuBarExtra("Liquid Agent", systemImage: "drop.fill") {
            QuickAsk()
                .environmentObject(state)
                .environmentObject(backends)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environmentObject(settings)
                .environmentObject(memory)
                .environmentObject(backends)
        }
    }
}

/// Menu bar quick ask: type, get an answer, without opening the window.
struct QuickAsk: View {
    @EnvironmentObject var state: AppState
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Ask Liquid Agent").font(.headline)
            TextField("Type a question and press Return", text: $text)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    state.newChat()
                    state.send(text)
                    text = ""
                }
            if state.running {
                HStack { ProgressView().controlSize(.small); Text(state.activity).foregroundStyle(.secondary) }
            }
            if let last = state.current?.messages.last(where: { $0.role == .assistant && !$0.text.isEmpty }) {
                ScrollView { Text(last.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(maxHeight: 220)
            }
            Divider()
            HStack {
                Button("Voice Chat") { open(); state.startVoiceChat() }
                Button("Look at Screen") { state.lookAtScreen() }
                Spacer()
                Button("Open App") { open() }
            }
            .buttonStyle(.borderless)
        }
        .padding(14)
        .frame(width: 360)
    }

    private func open() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first { $0.canBecomeMain }?.makeKeyAndOrderFront(nil)
    }
}

/// `LiquidAgent --install small,omni` downloads parts from the terminal.
enum HeadlessInstall {
    /// `LiquidAgent --probe "question"`: one model turn with the real system
    /// prompt against a running small model; prints raw output and the parsed call.
    static func probe() {
        let question = CommandLine.arguments.drop { $0 != "--probe" }.dropFirst().first ?? "What files are on my Desktop?"
        Task { @MainActor in
            let settings = AppSettings()
            let system = PromptBuilder.system(workspace: NSHomeDirectory(), memory: "", omni: false,
                                              personality: settings.personality, userName: "", browser: false)
            let llm = LLMClient(baseURL: settings.url(for: .lfm3_1_7b), model: settings.id(for: .lfm3_1_7b), temperature: settings.temperature)
            var raw = ""
            do {
                for try await chunk in llm.stream([WireMessage(role: "system", text: system), WireMessage(role: "user", text: question)],
                                                  stop: ToolParser.stops) { raw += chunk }
            } catch { print("error: \(error)"); exit(1) }
            let parsed = ToolParser.parse(raw)
            print("system tokens ≈ \(system.count / 4)")
            print("raw: \(raw.debugDescription)")
            print("prose: \(parsed.prose.debugDescription)")
            print("call: \(parsed.call.map { "\($0.name) \($0.args)" } ?? "none")")
            exit(0)
        }
        RunLoop.main.run()
    }

    static func run() {
        let names = CommandLine.arguments.drop { $0 != "--install" }.dropFirst().first ?? "engine,small"
        let parts = names.split(separator: ",").compactMap { Part(rawValue: String($0)) }
        Task { @MainActor in
            let backends = Backends()
            let watcher = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
                MainActor.assumeIsolated {
                    for p in parts { print("\(p.rawValue): \(backends.state(p))") }
                }
            }
            await backends.install(parts)
            watcher.invalidate()
            for p in parts { print("final \(p.rawValue): \(backends.state(p))") }
            backends.stopAll()
            exit(parts.allSatisfy { backends.installed($0) } ? 0 : 1)
        }
        RunLoop.main.run()
    }
}
