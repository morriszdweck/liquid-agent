import Foundation

struct GuardianVerdict {
    /// P(deny) from Auto 200M, nil when the guardian server is unreachable.
    var pDeny: Double?
    var approve: Bool
    var reason: String
}

/// Client for the local Auto 200M sidecar (guardian/server.py).
/// Builds the exact input format from the ProCreations/auto-200m-2 model card.
struct Guardian {
    var baseURL: String
    var threshold: Double

    struct HistoryItem { var tool: String; var args: String; var result: String }

    static func buildInput(request: String, history: [HistoryItem], call: ToolCall) -> String {
        var parts = ["### PROPOSED TOOL CALL", "tool: \(call.name)", "args: \(call.argsSummary)", "",
                     "### USER REQUEST", request, "", "### AGENT HISTORY"]
        if history.isEmpty {
            parts.append("(no prior actions)")
        } else {
            for (i, h) in history.enumerated() {
                parts.append("[\(i + 1)] \(h.tool)(\(h.args))\n-> \(h.result.prefix(400))")
            }
        }
        return parts.joined(separator: "\n")
    }

    func judge(request: String, history: [HistoryItem], call: ToolCall) async -> GuardianVerdict {
        // Hard rules first: never auto-approve these, whatever the classifier says.
        if let hit = Self.hardDeny(call) {
            return GuardianVerdict(pDeny: nil, approve: false, reason: "blocked pattern: \(hit)")
        }
        guard AppSettings.isLocal(baseURL), let url = URL(string: baseURL + "/classify") else {
            return GuardianVerdict(pDeny: nil, approve: false, reason: "guardian URL not local")
        }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let text = Self.buildInput(request: request, history: history.suffix(6), call: call)
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text])
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard let p = obj?["p_deny"] as? Double else {
                return GuardianVerdict(pDeny: nil, approve: false, reason: "bad guardian reply")
            }
            return GuardianVerdict(pDeny: p, approve: p < threshold,
                                   reason: p < threshold ? "Auto 200M: safe" : "Auto 200M: risky")
        } catch {
            return GuardianVerdict(pDeny: nil, approve: false, reason: "guardian offline")
        }
    }

    static let dangerous = ["rm -rf /", "rm -rf ~", "sudo ", "mkfs", "dd if=", ":(){", "chmod -R 777",
                            "curl | sh", "| sh", "| bash", "diskutil erase", "launchctl", "security ",
                            "csrutil", "defaults delete", "osascript"]

    static func hardDeny(_ call: ToolCall) -> String? {
        guard call.name == "shell" else { return nil }
        let cmd = (call.args["cmd"] ?? "").lowercased()
        return dangerous.first { cmd.contains($0) }
    }
}
