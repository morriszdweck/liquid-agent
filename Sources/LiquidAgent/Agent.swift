import Foundation

/// Builds token-lean prompts for 1.7B–2B models.
enum PromptBuilder {
    static func system(workspace: String, memory: String, omni: Bool, personality: Personality,
                       userName: String, browser: Bool) -> String {
        let tools = Toolbox.available(browser: browser).map { "- " + $0.signature }.joined(separator: "\n")
        let date = Date().formatted(date: .abbreviated, time: .shortened)
        return """
        You are Liquid Agent, a private assistant running locally on the user's Mac. \(personality.instruction)\(userName.isEmpty ? "" : " The user's name is \(userName).")
        For chat, questions and facts, just answer. To act on the Mac, files, web or memory, reply with one call only:
        <tool_call>
        <function=NAME>
        <parameter=ARG>
        VALUE
        </parameter>
        </function>
        </tool_call>
        Tools:
        \(tools)
        After a result, continue or answer. Use remember for lasting facts about the user.
        \(omni ? "You can see attached images.\n" : "")Now: \(date). Workspace: \(workspace)
        \(memory)
        """.trimmed
    }

    /// Replays a past call in the same XML form the prompt asks for.
    static func callText(_ call: ToolCall) -> String {
        let params = call.args.sorted { $0.key < $1.key }
            .map { "<parameter=\($0.key)>\n\($0.value)\n</parameter>\n" }.joined()
        return "<tool_call>\n<function=\(call.name)>\n\(params)</function>\n</tool_call>"
    }

    /// Newest-first packing into `budget` tokens (≈ chars / 4). Older tool
    /// results shrink first; whatever does not fit is dropped.
    static func wire(_ messages: [Message], system: String, budget: Int, toolLimit: Int, images: Bool) -> [WireMessage] {
        var out: [WireMessage] = []
        var used = system.count / 4
        let lastToolIndex = messages.lastIndex { $0.role == .tool } ?? -1
        for (index, m) in messages.enumerated().reversed() {
            var items: [WireMessage] = []
            switch m.role {
            case .user:
                items = [WireMessage(role: "user", text: m.text, imageDataURL: images ? dataURL(m.imagePath) : nil)]
            case .assistant:
                if !m.text.isEmpty { items = [WireMessage(role: "assistant", text: m.text)] }
            case .tool:
                guard let call = m.toolCall else { continue }
                let limit = index == lastToolIndex ? toolLimit : min(toolLimit, 240)
                var result = m.text
                if result.count > limit { result = String(result.prefix(limit)) + "…[truncated]" }
                items = [WireMessage(role: "assistant", text: callText(call)),
                         WireMessage(role: "user", text: "[result]\n" + result)]
            case .system:
                continue
            }
            let cost = items.reduce(0) { $0 + $1.text.count / 4 + 4 + ($1.imageDataURL == nil ? 0 : 256) }
            if used + cost > budget, !out.isEmpty { break }
            used += cost
            out.insert(contentsOf: items, at: 0)
        }
        // Drop images from all but the latest user turn to save tokens.
        if let last = out.lastIndex(where: { $0.imageDataURL != nil }) {
            for i in out.indices where i != last { out[i].imageDataURL = nil }
        }
        return [WireMessage(role: "system", text: system)] + mergeSameRole(out)
    }

    /// Some chat templates reject two user turns in a row.
    static func mergeSameRole(_ items: [WireMessage]) -> [WireMessage] {
        var merged: [WireMessage] = []
        for item in items {
            if var last = merged.last, last.role == item.role, last.imageDataURL == nil || item.imageDataURL == nil {
                last.text += "\n" + item.text
                last.imageDataURL = last.imageDataURL ?? item.imageDataURL
                merged[merged.count - 1] = last
            } else {
                merged.append(item)
            }
        }
        return merged
    }

    static func dataURL(_ path: String?) -> String? {
        guard let path, let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        let ext = (path as NSString).pathExtension.lowercased()
        let mime = ext == "png" ? "image/png" : "image/jpeg"
        return "data:\(mime);base64,\(data.base64EncodedString())"
    }
}
