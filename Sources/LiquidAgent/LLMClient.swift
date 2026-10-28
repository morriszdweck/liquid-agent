import Foundation

/// One message in the wire format of an OpenAI-compatible local server
/// (llama-server, mlx_lm.server, Ollama).
struct WireMessage {
    var role: String
    var text: String
    var imageDataURL: String?

    var json: [String: Any] {
        guard let imageDataURL else { return ["role": role, "content": text] }
        return ["role": role, "content": [
            ["type": "text", "text": text],
            ["type": "image_url", "image_url": ["url": imageDataURL]],
        ]]
    }
}

enum LLMError: LocalizedError {
    case notLocal(String)
    case badStatus(Int, String)

    var errorDescription: String? {
        switch self {
        case .notLocal(let url): "Refusing non-local endpoint \(url). Liquid Agent only talks to localhost."
        case .badStatus(let code, let body): "Model server returned \(code): \(body.prefix(200))"
        }
    }
}

struct LLMClient {
    var baseURL: String
    var model: String
    var temperature: Double

    /// Streams content deltas. Stops early on any of `stop`.
    func stream(_ messages: [WireMessage], maxTokens: Int = 768, stop: [String] = []) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard AppSettings.isLocal(baseURL) else { throw LLMError.notLocal(baseURL) }
                    var request = URLRequest(url: URL(string: baseURL + "/chat/completions")!)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    var body: [String: Any] = [
                        "model": model,
                        "messages": messages.map(\.json),
                        "stream": true,
                        "temperature": temperature,
                        "max_tokens": maxTokens,
                    ]
                    if !stop.isEmpty { body["stop"] = stop }
                    request.httpBody = try JSONSerialization.data(withJSONObject: body)

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                        var text = ""
                        for try await line in bytes.lines { text += line }
                        throw LLMError.badStatus(http.statusCode, text)
                    }
                    for try await line in bytes.lines {
                        guard line.hasPrefix("data:") else { continue }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        if payload == "[DONE]" { break }
                        guard let data = payload.data(using: .utf8),
                              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let choice = (obj["choices"] as? [[String: Any]])?.first,
                              let delta = choice["delta"] as? [String: Any],
                              let content = delta["content"] as? String
                        else { continue }
                        continuation.yield(content)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func complete(_ messages: [WireMessage], maxTokens: Int = 512) async throws -> String {
        var out = ""
        for try await chunk in stream(messages, maxTokens: maxTokens) { out += chunk }
        return out
    }
}
