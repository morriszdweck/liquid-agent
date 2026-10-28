import Foundation

/// Builds token-lean prompts for 1.7B–2B models.
enum PromptBuilder {
    static func system(workspace: String, memory: String, omni: Bool) -> String {
        let tools = Toolbox.all.map { "- " + $0.signature }.joined(separator: "\n")
        let date = Date().formatted(date: .abbreviated, time: .shortened)
        return """
        You are Liquid Agent, a private assistant running locally on the user's Mac. Be brief and direct.
        To act, write exactly one call and stop:
        \(ToolParser.start)[tool(arg="value")]\(ToolParser.end)
        Tools:
        \(tools)
        Use a tool only when needed. After a result, continue or answer. Use remember for lasting facts about the user.
        \(omni ? "You can see attached images.\n" : "")Now: \(date). Workspace: \(workspace)
        \(memory)
        """.trimmed
    }

    static func callText(_ call: ToolCall) -> String {
        let args = call.args.sorted { $0.key < $1.key }
            .map { "\($0.key)=\"\($0.value.replacingOccurrences(of: "\"", with: "\\\""))\"" }
            .joined(separator: ", ")
        return "\(ToolParser.start)[\(call.name)(\(args))]\(ToolParser.end)"
    }

    /// Newest-first packing into `budget` tokens (≈ chars / 4). Older tool
    /// results shrink first; whatever does not fit is dropped.
    static func wire(_ messages: [Message], system: String, budget: Int, toolLimit: Int) -> [WireMessage] {
        var out: [WireMessage] = []
        var used = system.count / 4
        let lastToolIndex = messages.lastIndex { $0.role == .tool } ?? -1
        for (index, m) in messages.enumerated().reversed() {
            var items: [WireMessage] = []
            switch m.role {
            case .user:
                items = [WireMessage(role: "user", text: m.text, imageDataURL: dataURL(m.imagePath))]
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
