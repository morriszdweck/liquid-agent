import SwiftUI

struct ContentView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var memory: MemoryStore
    @EnvironmentObject var backends: Backends

    var body: some View {
        NavigationSplitView {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 220, ideal: 250)
        } detail: {
            Group {
                switch state.screen {
                case .chat: ChatView()
                case .voice: VoiceModeView()
                case .forYou: ForYouView()
                case .routines: RoutinesView()
                case .memory: MemoryView()
                case .activity: ActivityView()
                case .setup: SetupView()
                }
            }
            .toolbar { toolbar }
        }
        .task {
            if settings.ideasOnLaunch, backends.ready, memory.ideas.isEmpty { state.refreshIdeas() }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup {
            Button { state.lookAtScreen() } label: { Label("Look at screen", systemImage: "rectangle.dashed.and.paperclip") }
                .help("Take a screenshot and ask about it")
            Button { state.toggleVoiceChat() } label: { Label("Voice chat", systemImage: "waveform") }
                .help("Talk out loud with Liquid Agent")
            Menu {
                Picker("Approval", selection: $settings.approvalMode) {
                    ForEach(ApprovalMode.allCases) { mode in
                        Label(mode.label, systemImage: mode.symbol).tag(mode)
                    }
                }
                .pickerStyle(.inline)
                Text(settings.approvalMode.detail)
            } label: {
                Label(settings.approvalMode.label, systemImage: settings.approvalMode.symbol)
                    .labelStyle(.titleAndIcon)
            }
            .help(settings.approvalMode.detail)
        }
    }
}

struct Sidebar: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var backends: Backends
    @State private var renaming: Conversation.ID?
    @State private var newTitle = ""

    var body: some View {
        VStack(spacing: 0) {
            List {
                Section {
                    NavRow(title: "New chat", symbol: "square.and.pencil", active: false) { state.newChat() }
                    NavRow(title: "Voice chat", symbol: "waveform", active: state.screen == .voice) { state.startVoiceChat() }
                    NavRow(title: "Look at my screen", symbol: "rectangle.dashed.and.paperclip", active: false) { state.lookAtScreen() }
                    NavRow(title: "For You", symbol: "sparkles", active: state.screen == .forYou) { state.screen = .forYou }
                    NavRow(title: "Routines", symbol: "repeat", active: state.screen == .routines) { state.screen = .routines }
                    NavRow(title: "Memory", symbol: "brain", active: state.screen == .memory) { state.screen = .memory }
                    NavRow(title: "Activity", symbol: "list.bullet.rectangle", active: state.screen == .activity) { state.screen = .activity }
                }

                Section("Chats") {
                    TextField("Search chats", text: $state.search)
                        .textFieldStyle(.roundedBorder)
                    ForEach(state.filteredConversations) { c in
                        Button { state.open(c.id) } label: {
                            Text(c.title).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 3)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(state.screen == .chat && state.selectedID == c.id
                                           ? RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.18)) : nil)
                        .contextMenu {
                            Button("Rename") { newTitle = c.title; renaming = c.id }
                            Button("Export…") { state.export(c.id) }
                            Divider()
                            Button("Delete", role: .destructive) { state.delete(c.id) }
                        }
                    }
                }
            }
            .listStyle(.sidebar)

            Divider()
            Button { state.screen = .setup } label: {
                HStack(spacing: 8) {
                    Image(systemName: backends.ready ? "checkmark.circle.fill" : "arrow.down.circle.fill")
                        .foregroundStyle(backends.ready ? .green : .orange)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(backends.ready ? "Ready · runs on this Mac" : "Finish setup").font(.callout)
                        Text("Setup and downloads").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    SettingsLink { Image(systemName: "gearshape") }.buttonStyle(.borderless)
                }
                .padding(10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $newTitle)
            Button("Save") { if let id = renaming { state.rename(id, to: newTitle) }; renaming = nil }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
    }
}

struct NavRow: View {
    var title: String
    var symbol: String
    var active: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 3)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(active ? RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.18)) : nil)
    }
}
