import SwiftUI

struct ChatView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var voice: VoiceController

    var body: some View {
        VStack(spacing: 0) {
            if let c = state.current, !c.messages.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            ForEach(c.messages) { m in
                                MessageRow(message: m).id(m.id)
                            }
                            if state.running {
                                HStack { Mascot(mood: state.mood, size: 22); Spacer() }.id("tail")
                            }
                        }
                        .frame(maxWidth: 760)
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

            if state.voiceChat {
                VoiceBar()
            }
            Composer()
                .frame(maxWidth: 760)
                .padding(.horizontal, 24)
                .padding(.bottom, 16)
        }
        .background(Color(nsColor: .textBackgroundColor))
    }
}

struct EmptyChat: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var memory: MemoryStore

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Mascot(mood: state.mood, size: 96)
            Text("What can I do for you?")
                .font(.system(size: 26, weight: .semibold))
            IdeasGrid()
                .frame(maxWidth: 640)
            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity)
    }
}

struct IdeasGrid: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var memory: MemoryStore

    private let starters = [
        Idea(title: "Tidy my Downloads", prompt: "List my Downloads folder and suggest how to organize it."),
        Idea(title: "Research on the web", prompt: "Open the browser and find today's top tech headline."),
        Idea(title: "Learn about me", prompt: "Ask me 3 quick questions so you can remember my preferences."),
        Idea(title: "Explain a file", prompt: "Read README.md in my workspace and summarize it."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(memory.ideas.isEmpty ? "Try" : "Ideas for you", systemImage: "sparkles")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                if memory.generatingIdeas {
                    ProgressView().controlSize(.small)
                } else {
                    Button { state.refreshIdeas() } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                        .help("Generate ideas from what Liquid Agent knows about you")
                }
            }
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(memory.ideas.isEmpty ? starters : memory.ideas) { idea in
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

struct VoiceBar: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var voice: VoiceController

    var body: some View {
        HStack(spacing: 12) {
            Mascot(mood: state.mood, size: 36, level: voice.level)
            Text(voice.listening ? (voice.partial.isEmpty ? "Listening…" : voice.partial)
                 : voice.speaking ? "Speaking…" : state.running ? "Thinking…" : "Voice chat on")
                .lineLimit(1)
                .foregroundStyle(.secondary)
            Spacer()
            if let error = voice.error { Text(error).font(.caption).foregroundStyle(.red) }
            Button("End") { state.toggleVoiceChat() }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .background(.bar)
    }
}
