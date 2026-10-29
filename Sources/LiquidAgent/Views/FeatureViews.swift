import SwiftUI

// MARK: Voice

struct VoiceModeView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var voice: VoiceController
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            ZStack {
                ForEach(0..<3) { ring in
                    Circle()
                        .stroke(Color.accentColor.opacity(0.25 - Double(ring) * 0.07), lineWidth: 2)
                        .frame(width: 170 + CGFloat(ring) * 40, height: 170 + CGFloat(ring) * 40)
                        .scaleEffect(1 + CGFloat(voice.level) * (0.15 + CGFloat(ring) * 0.08))
                }
                Circle()
                    .fill(LinearGradient(colors: [Color.accentColor, Color.accentColor.opacity(0.55)],
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 160, height: 160)
                    .scaleEffect(voice.speaking ? 1.05 : 1 + CGFloat(voice.level) * 0.12)
                Image(systemName: icon).font(.system(size: 44, weight: .medium)).foregroundStyle(.white)
            }
            .animation(.easeOut(duration: 0.12), value: voice.level)
            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: voice.speaking)

            Text(statusText).font(.title2.weight(.medium))
            Text(subtitle)
                .font(.title3).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).lineLimit(4)
                .frame(maxWidth: 560)
            if let error = voice.error {
                Text(error).foregroundStyle(.red)
            }
            Spacer()
            HStack(spacing: 20) {
                Toggle("Read replies aloud", isOn: $settings.speakReplies).toggleStyle(.switch)
                if state.voiceChat {
                    Button { voice.listening ? voice.stopListening() : state.listenForVoice() } label: {
                        Label(voice.listening ? "Pause" : "Speak", systemImage: voice.listening ? "pause.fill" : "mic.fill")
                    }
                    .controlSize(.large)
                    Button(role: .destructive) { state.endVoiceChat(); state.screen = .chat } label: {
                        Label("End", systemImage: "xmark")
                    }
                    .controlSize(.large)
                } else {
                    Button { state.startVoiceChat() } label: { Label("Start talking", systemImage: "mic.fill") }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                }
            }
            .padding(.bottom, 30)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var icon: String {
        if voice.speaking { return "speaker.wave.3.fill" }
        if voice.listening { return "mic.fill" }
        if state.running { return "ellipsis" }
        return "waveform"
    }

    private var statusText: String {
        if voice.listening { return "I'm listening" }
        if voice.speaking { return "Speaking" }
        if state.running { return state.activity.isEmpty ? "Thinking…" : state.activity }
        return state.voiceChat ? "Your turn" : "Voice chat"
    }

    private var subtitle: String {
        if voice.listening, !voice.partial.isEmpty { return voice.partial }
        if let last = state.current?.messages.last(where: { $0.role == .assistant && !$0.text.isEmpty }) { return last.text }
        return "Just talk. I'll answer out loud, then listen again."
    }
}

// MARK: For You

struct ForYouView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var memory: MemoryStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Header(title: "For You", subtitle: "Ideas made from what Liquid Agent knows about you. Tap one to start.")
                IdeasGrid(limit: 12)
                if memory.facts.isEmpty {
                    Callout(symbol: "brain", text: "I don't know much about you yet. Tell me about yourself and I'll make better ideas.") {
                        state.newChat()
                        state.send("Ask me 3 quick questions so you can remember my preferences.")
                    }
                }
            }
            .padding(28)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .task { if memory.ideas.isEmpty { state.refreshIdeas() } }
    }
}

// MARK: Routines

struct RoutinesView: View {
    @EnvironmentObject var state: AppState
    @State private var editing: Routine?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top) {
                    Header(title: "Routines", subtitle: "Things you ask for often. Run with one click, or every day at a set time.")
                    Spacer()
                    Button { editing = Routine(name: "", prompt: "") } label: { Label("New routine", systemImage: "plus") }
                        .buttonStyle(.borderedProminent)
                }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    ForEach(state.routines) { r in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Image(systemName: r.symbol).font(.title3).foregroundStyle(Color.accentColor)
                                Text(r.name).font(.headline)
                                Spacer()
                                Menu {
                                    Button("Edit") { editing = r }
                                    Button("Delete", role: .destructive) { state.deleteRoutine(r.id) }
                                } label: { Image(systemName: "ellipsis.circle") }
                                    .menuStyle(.borderlessButton).fixedSize()
                            }
                            Text(r.prompt).font(.callout).foregroundStyle(.secondary).lineLimit(3)
                            HStack {
                                if r.daily {
                                    Label(String(format: "Every day at %d:%02d", r.hour, r.minute), systemImage: "clock")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Run now") { state.run(r) }.buttonStyle(.bordered)
                            }
                        }
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 14).strokeBorder(.quaternary))
                    }
                }
            }
            .padding(28)
            .frame(maxWidth: 860, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .sheet(item: $editing) { r in RoutineEditor(routine: r) }
    }
}

struct RoutineEditor: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State var routine: Routine

    var body: some View {
        Form {
            TextField("Name", text: $routine.name)
            TextField("What should I do?", text: $routine.prompt, axis: .vertical).lineLimit(3...6)
            Picker("Icon", selection: $routine.symbol) {
                ForEach(["sparkles", "sun.max", "folder", "newspaper", "envelope", "calendar", "cart", "heart", "laptopcomputer", "book"], id: \.self) {
                    Image(systemName: $0).tag($0)
                }
            }
            Toggle("Run every day", isOn: $routine.daily)
            if routine.daily {
                DatePicker("At", selection: Binding(
                    get: { Calendar.current.date(bySettingHour: routine.hour, minute: routine.minute, second: 0, of: Date()) ?? Date() },
                    set: { let c = Calendar.current.dateComponents([.hour, .minute], from: $0); routine.hour = c.hour ?? 9; routine.minute = c.minute ?? 0 }
                ), displayedComponents: .hourAndMinute)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") { state.saveRoutine(routine); dismiss() }
                    .buttonStyle(.borderedProminent)
                    .disabled(routine.name.trimmed.isEmpty || routine.prompt.trimmed.isEmpty)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .padding()
    }
}

// MARK: Memory

struct MemoryView: View {
    @EnvironmentObject var memory: MemoryStore
    @EnvironmentObject var state: AppState
    @State private var newFact = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Header(title: "Memory", subtitle: "What Liquid Agent remembers about you. Stored only on this Mac. Remove anything anytime.")
            HStack {
                TextField("Tell me something to remember, like \"I love gardening\"", text: $newFact)
                    .textFieldStyle(.roundedBorder).onSubmit(add)
                Button("Remember", action: add).buttonStyle(.borderedProminent).disabled(newFact.trimmed.isEmpty)
            }
            if memory.facts.isEmpty {
                Callout(symbol: "brain", text: "Nothing yet. Chat normally and I'll remember useful things, or add them here.") {
                    state.newChat()
                    state.send("Ask me 3 quick questions so you can remember my preferences.")
                }
                Spacer()
            } else {
                List {
                    ForEach(memory.facts.reversed(), id: \.self) { fact in
                        HStack {
                            Image(systemName: "brain").foregroundStyle(.secondary)
                            Text(fact)
                            Spacer()
                            Button { memory.remove(fact) } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                        }
                        .padding(.vertical, 2)
                    }
                }
                .listStyle(.inset)
            }
        }
        .padding(28)
        .frame(maxWidth: 820)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private func add() {
        memory.add(newFact)
        newFact = ""
    }
}

// MARK: Activity

struct ActivityView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                Header(title: "Activity", subtitle: "Every action Liquid Agent took on your Mac, and who approved it.")
                Spacer()
                if !state.log.isEmpty {
                    Button("Clear") { state.log.removeAll(); state.save() }
                }
            }
            if state.log.isEmpty {
                Callout(symbol: "list.bullet.rectangle", text: "No actions yet. When I open files, browse or run commands, they show up here.", action: nil)
                Spacer()
            } else {
                Table(state.log) {
                    TableColumn("When") { Text($0.date.formatted(date: .abbreviated, time: .shortened)) }.width(140)
                    TableColumn("Action") { e in Text("\(e.tool)(\(e.args))").font(.system(.body, design: .monospaced)).lineLimit(1) }
                    TableColumn("Decision") { e in
                        Text(e.decision).foregroundStyle(e.decision.contains("Denied") ? .red : .green)
                    }.width(150)
                    TableColumn("Result") { Text($0.result).lineLimit(1).foregroundStyle(.secondary) }
                }
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

// MARK: Shared

struct Header: View {
    var title: String
    var subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 28, weight: .bold))
            Text(subtitle).foregroundStyle(.secondary)
        }
    }
}

struct Callout: View {
    var symbol: String
    var text: String
    var action: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.title2).foregroundStyle(Color.accentColor)
            Text(text)
            Spacer()
            if let action { Button("Let's go", action: action).buttonStyle(.borderedProminent) }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.accentColor.opacity(0.07)))
    }
}
