import SwiftUI

struct ChatView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        VStack(spacing: 0) {
            if let c = state.current, !c.messages.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            ForEach(c.messages) { m in
                                MessageRow(message: m, isLast: m.id == c.messages.last?.id).id(m.id)
                            }
                            if state.running {
                                StatusLine(text: state.activity).id("tail")
                            }
                        }
                        .font(.system(size: settings.textSize))
                        .frame(maxWidth: 780)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 20)
                        .frame(maxWidth: .infinity)
                    }
                    .onChange(of: c.messages.last?.text) { _, _ in
                        if state.running {
                            proxy.scrollTo("tail", anchor: .bottom)
                        } else if let last = c.messages.last?.id {
                            proxy.scrollTo(last, anchor: .bottom)
                        }
                    }
                    .onChange(of: c.messages.count) { _, _ in
                        withAnimation { proxy.scrollTo(c.messages.last?.id, anchor: .bottom) }
                    }
                }
            } else {
                EmptyChat()
            }

            Composer()
                .frame(maxWidth: 780)
                .padding(.horizontal, 24)
                .padding(.bottom, 16)
        }
        .background(Color(nsColor: .textBackgroundColor))
    }
}

struct StatusLine: View {
    var text: String

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text.isEmpty ? "Thinking…" : text).font(.callout).foregroundStyle(.secondary)
        }
    }
}

struct EmptyChat: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var backends: Backends

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                Spacer(minLength: 40)
                Text(greeting)
                    .font(.system(size: 30, weight: .semibold))
                Text("Private. Runs entirely on your Mac.")
                    .foregroundStyle(.secondary)

                if !backends.ready {
                    Button { state.screen = .setup } label: {
                        Label("Set up Liquid Agent (one click)", systemImage: "arrow.down.circle.fill")
                            .font(.title3).padding(.horizontal, 18).padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }

                HStack(spacing: 12) {
                    FeatureTile(title: "Talk to me", detail: "Voice chat, hands free", symbol: "waveform") { state.startVoiceChat() }
                    FeatureTile(title: "Look at my screen", detail: "I'll see what you see", symbol: "rectangle.dashed.and.paperclip") { state.lookAtScreen() }
                    FeatureTile(title: "Search the web", detail: "I browse for you", symbol: "globe") {
                        state.send("Search the web for today's top tech news and summarize it.")
                    }
                    FeatureTile(title: "Routines", detail: "One-click tasks", symbol: "repeat") { state.screen = .routines }
                }
                .frame(maxWidth: 760)

                IdeasGrid().frame(maxWidth: 760)
                Spacer(minLength: 20)
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
        return settings.userName.isEmpty ? "\(part)!" : "\(part), \(settings.userName)!"
    }
}

struct FeatureTile: View {
    var title: String
    var detail: String
    var symbol: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: symbol).font(.title2).foregroundStyle(Color.accentColor)
                Text(title).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.accentColor.opacity(0.07)))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.accentColor.opacity(0.18)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct IdeasGrid: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var memory: MemoryStore
    var limit = 4

    private let starters = [
        Idea(title: "Tidy my Downloads", prompt: "List my Downloads folder and suggest how to organize it."),
        Idea(title: "Get to know me", prompt: "Ask me 3 quick questions so you can remember my preferences."),
        Idea(title: "Write a nice message", prompt: "Help me write a short thank-you note to a friend."),
        Idea(title: "Remind me later", prompt: "Remind me to stretch in 30 minutes."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(memory.ideas.isEmpty ? "Try asking" : "Ideas for you", systemImage: "sparkles")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                if memory.generatingIdeas {
                    ProgressView().controlSize(.small)
                } else {
                    Button { state.refreshIdeas() } label: { Label("New ideas", systemImage: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                        .help("Make ideas from what Liquid Agent knows about you")
                }
            }
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach((memory.ideas.isEmpty ? starters : memory.ideas).prefix(limit)) { idea in
                    Button { state.send(idea.prompt) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(idea.title).font(.callout.weight(.medium))
                            Text(idea.prompt).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                        .frame(maxWidth: .infinity, minHeight: 54, alignment: .topLeading)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}
