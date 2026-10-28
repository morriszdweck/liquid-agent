import SwiftUI

struct ContentView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var memory: MemoryStore

    var body: some View {
        NavigationSplitView {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 200, ideal: 240)
        } detail: {
            ChatView()
                .toolbar { toolbar }
        }
        .task {
            if settings.ideasOnLaunch, memory.ideas.isEmpty { state.refreshIdeas() }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Menu {
                Picker("Model", selection: $settings.model) {
                    ForEach(ModelChoice.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.inline)
            } label: {
                HStack(spacing: 4) {
                    Text("Liquid Agent").fontWeight(.semibold)
                    Text(settings.model.label).foregroundStyle(.secondary)
                    Image(systemName: "chevron.down").font(.caption2)
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        ToolbarItem {
            Menu {
                Picker("Approval", selection: $settings.approvalMode) {
                    ForEach(ApprovalMode.allCases) { mode in
                        Label {
                            VStack(alignment: .leading) {
                                Text(mode.label)
                                Text(mode.detail)
                            }
                        } icon: { Image(systemName: mode.symbol) }
                        .tag(mode)
                    }
                }
                .pickerStyle(.inline)
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

    var body: some View {
        VStack(spacing: 0) {
            Button {
                state.newChat()
            } label: {
                Label("New chat", systemImage: "square.and.pencil")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary.opacity(0.5)))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.top, 8)

            List(selection: $state.selectedID) {
                Section("Chats") {
                    ForEach(state.conversations.filter { !$0.messages.isEmpty || $0.id == state.selectedID }) { c in
                        Text(c.title)
                            .lineLimit(1)
                            .tag(c.id)
                            .contextMenu {
                                Button("Delete", role: .destructive) { state.delete(c.id) }
                            }
                    }
                }
            }
            .listStyle(.sidebar)

            HStack(spacing: 8) {
                Mascot(mood: state.mood, size: 26)
                Text("Local only").font(.caption).foregroundStyle(.secondary)
                Spacer()
                SettingsLink { Image(systemName: "gearshape") }
                    .buttonStyle(.borderless)
            }
            .padding(10)
        }
    }
}
