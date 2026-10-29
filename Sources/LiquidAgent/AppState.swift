import AppKit
import Foundation
import SwiftUI
import UserNotifications

enum Screen: Hashable {
    case chat
    case voice
    case forYou
    case routines
    case memory
    case activity
    case setup
}

@MainActor
final class AppState: ObservableObject {
    @Published var conversations: [Conversation] = []
    @Published var selectedID: Conversation.ID?
    @Published var screen: Screen = .chat
    @Published var running = false
    /// Short status line shown while the agent works ("Thinking…").
    @Published var activity = ""
    @Published var voiceChat = false
    @Published var routines: [Routine] = []
    @Published var log: [ActivityEntry] = []
    @Published var search = ""

    let settings: AppSettings
    let memory: MemoryStore
    let voice: VoiceController
    let backends: Backends

    private var runTask: Task<Void, Never>?
    private var approvals: [UUID: CheckedContinuation<Bool, Never>] = [:]
    private var routineTimer: Timer?

    init(settings: AppSettings, memory: MemoryStore, voice: VoiceController, backends: Backends) {
        self.settings = settings
        self.memory = memory
        self.voice = voice
        self.backends = backends
        conversations = Storage.load([Conversation].self, "conversations.json")?.sorted { $0.updated > $1.updated } ?? []
        routines = Storage.load([Routine].self, "routines.json") ?? Self.starterRoutines
        log = Storage.load([ActivityEntry].self, "activity.json") ?? []
        if conversations.isEmpty { newChat() }
        selectedID = selectedID ?? conversations.first?.id
        if !backends.ready { screen = .setup }
        routineTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.runDueRoutines() }
        }
    }

    // MARK: Conversations

    var current: Conversation? { conversations.first { $0.id == selectedID } }
    private var currentIndex: Int? { conversations.firstIndex { $0.id == selectedID } }

    var filteredConversations: [Conversation] {
        let visible = conversations.filter { !$0.messages.isEmpty || $0.id == selectedID }
        guard !search.trimmed.isEmpty else { return visible }
        return visible.filter { c in
            c.title.localizedCaseInsensitiveContains(search) || c.messages.contains { $0.text.localizedCaseInsensitiveContains(search) }
        }
    }

    func newChat() {
        screen = .chat
        if let c = current, c.messages.isEmpty { return }
        let c = Conversation()
        conversations.insert(c, at: 0)
        selectedID = c.id
    }

    func open(_ id: Conversation.ID) {
        selectedID = id
        screen = .chat
    }

    func delete(_ id: Conversation.ID) {
        conversations.removeAll { $0.id == id }
        if selectedID == id { selectedID = conversations.first?.id }
        if conversations.isEmpty { newChat() }
        save()
    }

    func rename(_ id: Conversation.ID, to title: String) {
        guard let i = conversations.firstIndex(where: { $0.id == id }), !title.trimmed.isEmpty else { return }
        conversations[i].title = title.trimmed
        save()
    }

    func export(_ id: Conversation.ID) {
        guard let c = conversations.first(where: { $0.id == id }) else { return }
        let text = c.messages.compactMap { m -> String? in
            switch m.role {
            case .user: "**You:** \(m.text)"
            case .assistant: m.text.isEmpty ? nil : "**Liquid Agent:** \(m.text)"
            case .tool: m.toolCall.map { "> \($0.name)(\($0.argsSummary))" }
            case .system: nil
            }
        }.joined(separator: "\n\n")
        let panel = NSSavePanel()
        panel.nameFieldStringValue = c.title + ".md"
        if panel.runModal() == .OK, let url = panel.url { try? ("# \(c.title)\n\n" + text).write(to: url, atomically: true, encoding: .utf8) }
    }

    private func mutate(_ body: (inout Conversation) -> Void) {
        guard let i = currentIndex else { return }
        body(&conversations[i])
        conversations[i].updated = Date()
    }

    private func append(_ m: Message) { mutate { $0.messages.append(m) } }

    private func update(_ id: UUID, _ body: (inout Message) -> Void) {
        mutate { c in
            if let j = c.messages.firstIndex(where: { $0.id == id }) { body(&c.messages[j]) }
        }
    }

    // MARK: Model routing

    /// Picks the brain automatically: Omni for pictures, 1.7B for everything else.
    func route(needsVision: Bool) -> ModelChoice? {
        let small = backends.installed(.small), omni = backends.installed(.omni)
        if needsVision { return omni ? .lfm3_2b_omni : nil }
        if small { return .lfm3_1_7b }
        if omni { return .lfm3_2b_omni }
        return .lfm3_1_7b // maybe a server the user runs themselves
    }

    func client(_ model: ModelChoice) -> LLMClient {
        LLMClient(baseURL: settings.url(for: model), model: settings.id(for: model), temperature: settings.temperature)
    }

    var anyClient: LLMClient { client(route(needsVision: false) ?? .lfm3_1_7b) }

    // MARK: Sending

    func send(_ text: String, attachments: [Attachment] = []) {
        var body = text.trimmed
        guard !body.isEmpty || !attachments.isEmpty, !running else { return }
        if screen != .voice { screen = .chat }
        if current == nil { newChat() }

        let image = attachments.first { $0.isImage }
        var fileName: String?
        for file in attachments where !file.isImage {
            if let content = try? String(contentsOfFile: file.path, encoding: .utf8) {
                body += "\n\n[File \(file.name)]\n" + String(content.prefix(4000))
                fileName = file.name
            }
        }
        if body.isEmpty { body = "What is in this picture?" }

        append(Message(role: .user, text: body, imagePath: image?.path, fileName: fileName))
        mutate { c in
            if c.title == "New chat" { c.title = String(text.trimmed.prefix(40)).isEmpty ? "Picture" : String(text.trimmed.prefix(40)) }
        }

        guard let model = route(needsVision: image != nil) else {
            append(Message(role: .assistant, text: "To look at pictures I need **Eyes and ears** (LFM3 Omni 2B). Open **Setup** in the sidebar and tap Download. It only takes a few minutes."))
            save()
            return
        }
        runTask = Task { await runAgent(request: body, model: model) }
    }

    func regenerate() {
        guard !running, let c = current, let lastUser = c.messages.lastIndex(where: { $0.role == .user }) else { return }
        let request = c.messages[lastUser]
        mutate { $0.messages.removeSubrange((lastUser + 1)...) }
        let model = route(needsVision: request.imagePath != nil) ?? .lfm3_1_7b
        runTask = Task { await runAgent(request: request.text, model: model) }
    }

    /// Takes a screenshot and asks Omni about it.
    func lookAtScreen(question: String = "What's on my screen? Help me with it.") {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("liquid-screen-\(Int(Date().timeIntervalSince1970)).png").path
        NSApp.hide(nil)
        Task {
            try? await Task.sleep(for: .milliseconds(450))
            _ = try? await Exec.run("/usr/sbin/screencapture", ["-x", "-C", path])
            NSApp.unhide(nil)
            NSApp.activate(ignoringOtherApps: true)
            if FileManager.default.fileExists(atPath: path) {
                send(question, attachments: [Attachment(path: path)])
            } else {
                screen = .chat
                append(Message(role: .assistant, text: "I couldn't take a screenshot. Allow Liquid Agent in System Settings → Privacy & Security → Screen Recording, then try again."))
            }
        }
    }

    func stop() {
        runTask?.cancel()
        for (_, c) in approvals { c.resume(returning: false) }
        approvals.removeAll()
        voice.stopSpeaking()
        voice.stopListening()
        voiceChat = false
        running = false
        activity = ""
    }

    func readAloud(_ text: String) {
        voice.speaking ? voice.stopSpeaking() : voice.speak(text)
    }

    // MARK: Agent loop

    private func runAgent(request: String, model: ModelChoice) async {
        running = true
        activity = "Thinking…"
        defer {
            running = false
            activity = ""
            save()
        }
        let ctx = ToolContext(workspace: settings.workspace, memory: memory,
                              browser: BrowserBridge(baseURL: settings.browserURL))
        let guardian = Guardian(baseURL: settings.guardianURL, threshold: settings.guardianThreshold)
        let llm = client(model)
        var history: [Guardian.HistoryItem] = []
        var finalText = ""

        for _ in 0..<settings.maxSteps {
            if Task.isCancelled { return }
            let system = PromptBuilder.system(workspace: settings.workspace,
                                              memory: memory.promptBlock(for: request),
                                              omni: model.supportsImages,
                                              personality: settings.personality,
                                              userName: settings.userName,
                                              browser: backends.installed(.browser))
            let wire = PromptBuilder.wire(current?.messages ?? [], system: system, budget: settings.contextBudget,
                                          toolLimit: settings.toolOutputLimit, images: model.supportsImages)
            let reply = Message(role: .assistant, text: "", model: model.label)
            append(reply)
            activity = "Thinking…"

            var raw = ""
            do {
                for try await chunk in llm.stream(wire, stop: ToolParser.stops) {
                    raw += chunk
                    let visible = ToolParser.visible(raw)
                    update(reply.id) { $0.text = visible }
                }
            } catch {
                if Task.isCancelled { return }
                let part: Part = model == .lfm3_2b_omni ? .omni : .small
                let hint = backends.installed(part)
                    ? "My \(part.title.lowercased()) is still waking up. Give it a few seconds and try again."
                    : "I need to download my \(part.title.lowercased()) first. Open **Setup** in the sidebar."
                update(reply.id) { $0.text = "I couldn't think just now. \(hint)" }
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
                activity = "Working: \(call.name.replacingOccurrences(of: "_", with: " "))…"
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
            record(call, approved: approved, messageID: toolMessage.id, result: result)
        }

        if !NSApp.isActive, !finalText.isEmpty { notify("Liquid Agent finished", finalText) }
        if settings.speakReplies || voiceChat, !finalText.isEmpty {
            activity = "Speaking…"
            voice.speak(finalText) { [weak self] in
                guard let self else { return }
                if self.voiceChat { self.listenForVoice() }
            }
        }
    }

    /// Applies the approval mode. Returns whether the call may run.
    private func decide(_ call: ToolCall, messageID: UUID, request: String,
                        history: [Guardian.HistoryItem], guardian: Guardian) async -> Bool {
        switch settings.approvalMode {
        case .fullAuto:
            if let hit = Guardian.hardDeny(call) {
                update(messageID) { $0.text = "This looks risky (\(hit)). Please check it." }
                return await askUser(messageID)
            }
            update(messageID) { $0.approval = .autoApproved }
            return true
        case .askAlways:
            return await askUser(messageID)
        case .approveForMe:
            activity = "Checking it's safe…"
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
        activity = "Waiting for your OK"
        update(messageID) { $0.approval = .pending }
        if !NSApp.isActive { notify("Liquid Agent needs your OK", "Open the app to approve or deny an action.") }
        let ok = await withCheckedContinuation { c in approvals[messageID] = c }
        update(messageID) { $0.approval = ok ? .approved : .denied }
        return ok
    }

    func resolveApproval(_ messageID: UUID, approve: Bool) {
        approvals.removeValue(forKey: messageID)?.resume(returning: approve)
    }

    private func record(_ call: ToolCall, approved: Bool, messageID: UUID, result: String) {
        let status = current?.messages.first { $0.id == messageID }?.approval
        let decision = switch status {
        case .autoApproved: settings.approvalMode == .fullAuto ? "Auto (Full Auto)" : "Auto 200M approved"
        case .approved: "You approved"
        default: approved ? "Approved" : "Denied"
        }
        log.insert(ActivityEntry(tool: call.name, args: call.argsSummary, decision: decision, result: String(result.prefix(300))), at: 0)
        if log.count > 500 { log.removeLast(log.count - 500) }
    }

    // MARK: Voice chat

    func startVoiceChat() {
        screen = .voice
        if current == nil || !(current?.messages.isEmpty ?? true) { newChat(); screen = .voice }
        voiceChat = true
        listenForVoice()
    }

    func endVoiceChat() {
        voiceChat = false
        voice.stopListening()
        voice.stopSpeaking()
        activity = ""
    }

    func toggleVoiceChat() { voiceChat ? endVoiceChat() : startVoiceChat() }

    func listenForVoice() {
        activity = "Listening…"
        voice.listen { [weak self] text in self?.send(text) }
    }

    // MARK: Ideas

    func refreshIdeas() {
        Task { await memory.generateIdeas(client: anyClient) }
    }

    // MARK: Routines

    static let starterRoutines = [
        Routine(name: "Morning briefing", prompt: "Give me a short, cheerful plan for today based on what you know about me.", symbol: "sun.max", daily: false, hour: 8),
        Routine(name: "Tidy Downloads", prompt: "List my Downloads folder and suggest how to organize it. Don't move anything yet.", symbol: "folder"),
        Routine(name: "Today's news", prompt: "Search the web for today's top 3 headlines and summarize each in one line.", symbol: "newspaper"),
        Routine(name: "Check my Mac", prompt: "Check free disk space and battery health and tell me if anything needs attention.", symbol: "laptopcomputer"),
    ]

    func run(_ routine: Routine) {
        newChat()
        send(routine.prompt)
        if let i = routines.firstIndex(where: { $0.id == routine.id }) { routines[i].lastRun = Date() }
        save()
    }

    func saveRoutine(_ routine: Routine) {
        if let i = routines.firstIndex(where: { $0.id == routine.id }) { routines[i] = routine } else { routines.append(routine) }
        save()
    }

    func deleteRoutine(_ id: Routine.ID) {
        routines.removeAll { $0.id == id }
        save()
    }

    private func runDueRoutines() {
        guard !running else { return }
        let now = Date(), cal = Calendar.current
        for r in routines where r.daily {
            let comps = cal.dateComponents([.hour, .minute], from: now)
            guard comps.hour == r.hour, (comps.minute ?? 0) >= r.minute else { continue }
            if let last = r.lastRun, cal.isDate(last, inSameDayAs: now) { continue }
            run(r)
            notify("Routine started", r.name)
            return
        }
    }

    // MARK: Notifications

    func notify(_ title: String, _ body: String) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = String(body.prefix(180))
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    // MARK: Persistence

    func save() {
        Storage.save(conversations.filter { !$0.messages.isEmpty }, "conversations.json")
        Storage.save(routines, "routines.json")
        Storage.save(log, "activity.json")
    }
}

extension Storage {
    static func load<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    static func save<T: Encodable>(_ value: T, _ name: String) {
        try? JSONEncoder().encode(value).write(to: dir.appendingPathComponent(name))
    }
}
