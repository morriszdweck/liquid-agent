import Foundation

/// Talks to the local Betterwright bridge (bridge/server.mjs), which keeps a
/// persistent Betterwright session alive between agent turns.
struct BrowserBridge {
    var baseURL: String

    func goto(_ url: String) async throws -> String { try await call("goto", ["url": url]) }
    func read() async throws -> String { try await call("read", [:]) }
    func click(_ target: String) async throws -> String { try await call("click", ["target": target]) }
    func type(_ target: String, text: String) async throws -> String {
        try await call("type", ["target": target, "text": text])
    }

    private func call(_ action: String, _ args: [String: String]) async throws -> String {
        guard AppSettings.isLocal(baseURL), let url = URL(string: baseURL + "/" + action) else {
            throw LLMError.notLocal(baseURL)
        }
        var req = URLRequest(url: url, timeoutInterval: 60)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: args)
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            if let error = obj?["error"] as? String { return "error: \(error)" }
            return obj?["text"] as? String ?? String(decoding: data, as: UTF8.self)
        } catch let error as URLError where error.code == .cannotConnectToHost {
            return "error: Betterwright bridge not running. Start it with scripts/start-backends.sh"
        }
    }
}
