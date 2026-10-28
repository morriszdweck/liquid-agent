import Foundation

struct Idea: Identifiable, Codable, Hashable {
    var id = UUID()
    var title: String
    var prompt: String
}

/// Long-term facts about the user plus the idea feed generated from them.
@MainActor
final class MemoryStore: ObservableObject {
    @Published private(set) var facts: [String] = []
    @Published var ideas: [Idea] = []
    @Published var generatingIdeas = false

    private let url = Storage.dir.appendingPathComponent("memory.json")

    init() {
        if let data = try? Data(contentsOf: url),
           let saved = try? JSONDecoder().decode([String].self, from: data) {
            facts = saved
        }
    }

    func add(_ fact: String) {
        let clean = fact.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !facts.contains(where: { $0.caseInsensitiveCompare(clean) == .orderedSame }) else { return }
        facts.append(clean)
        save()
    }

    func remove(_ fact: String) {
        facts.removeAll { $0 == fact }
        save()
    }

    /// Keyword overlap search. Cheap, no embeddings, fine for a few hundred facts.
    func search(_ query: String, limit: Int = 5) -> [String] {
        let words = Set(query.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count > 2 })
        guard !words.isEmpty else { return Array(facts.suffix(limit)) }
        return facts
            .map { fact in (fact, words.filter { fact.lowercased().contains($0) }.count) }
            .filter { $0.1 > 0 }
            .sorted { $0.1 > $1.1 }
            .prefix(limit)
            .map(\.0)
    }

    /// Compact block injected into the system prompt.
    func promptBlock(for query: String) -> String {
        let relevant = search(query, limit: 4)
        let recent = facts.suffix(3)
        let picked = Array(NSOrderedSet(array: relevant + recent)) as? [String] ?? []
        return picked.isEmpty ? "" : "User facts: " + picked.joined(separator: "; ")
    }

    /// Asks the model for idea cards based on what it knows about the user.
    func generateIdeas(client: LLMClient) async {
        guard !generatingIdeas else { return }
        generatingIdeas = true
        defer { generatingIdeas = false }
        let known = facts.suffix(15).joined(separator: "\n- ")
        let prompt = """
        Facts about the user:
        - \(known.isEmpty ? "(none yet)" : known)
        Suggest 4 short, specific things I could do for them today. One per line as: Title | request to the agent
        """
        guard let reply = try? await client.complete([
            WireMessage(role: "system", text: "You are Liquid Agent. Be concise."),
            WireMessage(role: "user", text: prompt),
        ], maxTokens: 220) else { return }
        ideas = reply.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "|", maxSplits: 1).map {
                $0.trimmingCharacters(in: CharacterSet(charactersIn: " -*0123456789.\t"))
            }
            guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
            return Idea(title: parts[0], prompt: parts[1])
        }
    }

    private func save() {
        try? JSONEncoder().encode(facts).write(to: url)
    }
}

enum Storage {
    static let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LiquidAgent", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()
}
