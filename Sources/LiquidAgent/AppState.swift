import Foundation
import SwiftUI

enum MascotMood: Equatable {
    case idle, thinking, working, listening, speaking, alert, happy, error
}

@MainActor
final class AppState: ObservableObject {
    @Published var conversations: [Conversation] = []
    @Published var selectedID: Conversation.ID?
    @Published var running = false
    @Published var mood: MascotMood = .idle
    @Published var voiceChat = false
    @Published var showIdeas = true

    let settings: AppSettings
    let memory: MemoryStore
    let voice: VoiceController

    private var runTask: Task<Void, Never>?
    private var approvals: [UUID: CheckedContinuation<Bool, Never>] = [:]
    private let saveURL = Storage.dir.appendingPathComponent("conversations.json")

    init(settings: AppSettings, memory: MemoryStore, voice: VoiceController) {
        self.settings = settings
        self.memory = memory
        self.voice = voice
        load()
        if conversations.isEmpty { newChat() }
        selectedID = selectedID ?? conversations.first?.id
    }

    // MARK: Conversations

    var current: Conversation? {
        conversations.first { $0.id == selectedID }
    }

    private var currentIndex: Int? {
        conversations.firstIndex { $0.id == selectedID }
    }

    func newChat() {
        if let c = current, c.messages.isEmpty { return }
        let c = Conversation()
        conversations.insert(c, at: 0)
        selectedID = c.id
    }

    func delete(_ id: Conversation.ID) {
        conversations.removeAll { $0.id == id }
        if selectedID == id { selectedID = conversations.first?.id }
        if conversations.isEmpty { newChat() }
        save()
    }

    private func mutate(_ body: (inout Conversation) -> Void) {
        guard let i = currentIndex else { return }
        body(&conversations[i])
        conversations[i].updated = Date()
    }

    private func append(_ m: Message) {
        mutate { $0.messages.append(m) }
    }

    private func update(_ id: UUID, _ body: (inout Message) -> Void) {
        mutate { c in
            if let j = c.messages.firstIndex(where: { $0.id == id }) { body(&c.messages[j]) }
        }
    }

    // MARK: Agent loop

    var client: LLMClient {
        LLMClient(baseURL: settings.llmURL, model: settings.modelId, temperature: settings.temperature)
    }

    func send(_ text: String, imagePath: String? = nil) {
        let trimmed = text.trimmed
        guard !trimmed.isEmpty, !running else { return }
        if current == nil { newChat() }
        append(Message(role: .user, text: trimmed, imagePath: settings.model.supportsImages ? imagePath : nil))
        mutate { c in
            if c.title == "New chat" { c.title = String(trimmed.prefix(40)) }
        }
        runTask = Task { await runAgent(request: trimmed) }
    }

    func stop() {
        runTask?.cancel()
        for (_, c) in approvals { c.resume(returning: false) }
        approvals.removeAll()
        voice.stopSpeaking()
        voice.stopListening()
        voiceChat = false
        running = false
        mood = .idle
    }

    private func runAgent(request: String) async {
        running = true
        mood = .thinking
        defer {
            running = false
            if mood != .error { mood = .idle }
            save()
        }
        let ctx = ToolContext(workspace: settings.workspace, memory: memory,
                              browser: BrowserBridge(baseURL: settings.browserURL))
        let guardian = Guardian(baseURL: settings.guardianURL, threshold: settings.guardianThreshold)
        var history: [Guardian.HistoryItem] = []
        var finalText = ""

        for _ in 0..<settings.maxSteps {
            if Task.isCancelled { return }
            let system = PromptBuilder.system(workspace: settings.workspace,
                                              memory: memory.promptBlock(for: request),
                                              omni: settings.model.supportsImages)
            let wire = PromptBuilder.wire(current?.messages ?? [], system: system,
                                          budget: settings.contextBudget, toolLimit: settings.toolOutputLimit)
            let reply = Message(role: .assistant, text: "")
            append(reply)
            mood = .thinking

            var raw = ""
            do {
                for try await chunk in client.stream(wire, stop: [ToolParser.end]) {
                    raw += chunk
                    let visible = raw.components(separatedBy: ToolParser.start).first ?? raw
                    update(reply.id) { $0.text = visible }
                }
            } catch {
                if Task.isCancelled { return }
                update(reply.id) { $0.text = "⚠️ \(error.localizedDescription)\n\nIs the model server running? See Settings → Models." }
                mood = .error
                return
            }

            let (prose, call) = ToolParser.parse(raw)
            update(reply.id) { $0.text = prose }
            guard let call else {
                finalText = prose
                break
            }
            if prose.isEmpty { mutate { $0.messages.removeAll { $0.id == reply.id } } }

            let toolMessage = Message(role: .tool, text: "", toolCall: call, approval: .pending)
            append(toolMessage)
            let approved = await decide(call, messageID: toolMessage.id, request: request,
                                        history: history, guardian: guardian)
            if Task.isCancelled { return }

            var result: String
            if approved {
                mood = .working
                if let tool = Toolbox.named(call.name) {
                    do { result = try await tool.run(call.args, ctx) } catch { result = "error: \(error.localizedDescription)" }
                } else {
                    result = "error: unknown tool \(call.name). Available: " + Toolbox.all.map(\.name).joined(separator: ", ")
                }
            } else {
                result = "Denied. Do not retry this action; ask the user or choose another way."
            }
            if result.trimmed.isEmpty { result = "(no output)" }
            update(toolMessage.id) { $0.text = result }
            history.append(.init(tool: call.name, args: call.argsSummary, result: result))
        }

        mood = .happy
        if settings.speakReplies || voiceChat, !finalText.isEmpty {
            mood = .speaking
            voice.speak(finalText) { [weak self] in
                guard let self else { return }
                self.mood = .idle
                if self.voiceChat { self.listenForVoice() }
            }
        } else {
            try? await Task.sleep(for: .seconds(1.2))
        }
    }

    /// Applies the approval mode. Returns whether the call may run.
    private func decide(_ call: ToolCall, messageID: UUID, request: String,
                        history: [Guardian.HistoryItem], guardian: Guardian) async -> Bool {
        switch settings.approvalMode {
        case .fullAuto:
            if let hit = Guardian.hardDeny(call) {
                update(messageID) { $0.text = "blocked pattern: \(hit)" }
                return await askUser(messageID)
            }
            update(messageID) { $0.approval = .autoApproved }
            return true
        case .askAlways:
            return await askUser(messageID)
        case .approveForMe:
            mood = .thinking
            let verdict = await guardian.judge(request: request, history: history, call: call)
            update(messageID) { $0.guardianScore = verdict.pDeny }
            if verdict.approve {
                update(messageID) { $0.approval = .autoApproved }
                return true
            }
            update(messageID) { $0.text = verdict.reason }
            return await askUser(messageID)
        }
    }

    private func askUser(_ messageID: UUID) async -> Bool {
        mood = .alert
        update(messageID) { $0.approval = .pending }
        let ok = await withCheckedContinuation { c in approvals[messageID] = c }
        update(messageID) { $0.approval = ok ? .approved : .denied }
        return ok
    }

    func resolveApproval(_ messageID: UUID, approve: Bool) {
        approvals.removeValue(forKey: messageID)?.resume(returning: approve)
    }

    // MARK: Voice chat

    func toggleVoiceChat() {
        voiceChat.toggle()
        if voiceChat { listenForVoice() } else { voice.stopListening(); voice.stopSpeaking(); mood = .idle }
    }

    func listenForVoice() {
        mood = .listening
        voice.listen { [weak self] text in
            self?.send(text)
        }
    }

    // MARK: Ideas

    func refreshIdeas() {
        Task { await memory.generateIdeas(client: client) }
    }

    // MARK: Persistence

    func save() {
        let trimmed = conversations.filter { !$0.messages.isEmpty }
        try? JSONEncoder().encode(trimmed).write(to: saveURL)
    }

    private func load() {
        guard let data = try? Data(contentsOf: saveURL),
              let saved = try? JSONDecoder().decode([Conversation].self, from: data) else { return }
        conversations = saved.sorted { $0.updated > $1.updated }
    }
}
