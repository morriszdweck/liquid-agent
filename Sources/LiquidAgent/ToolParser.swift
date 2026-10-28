import Foundation

/// Parses tool calls from small-model output. Accepts LFM's native pythonic
/// form `<|tool_call_start|>[shell(cmd="ls")]<|tool_call_end|>`, the same call
/// without special tokens, and a JSON fallback `{"name":..,"args":{..}}`.
enum ToolParser {
    static let start = "<|tool_call_start|>"
    static let end = "<|tool_call_end|>"

    /// Returns the text before the call and the call itself, if any.
    static func parse(_ output: String) -> (prose: String, call: ToolCall?) {
        if let range = output.range(of: start) {
            let prose = String(output[..<range.lowerBound])
            var body = String(output[range.upperBound...])
            if let endRange = body.range(of: end) { body = String(body[..<endRange.lowerBound]) }
            return (prose.trimmed, parseBody(body))
        }
        // Bare call on its own line, e.g. `[shell(cmd="ls")]`.
        for line in output.split(separator: "\n").reversed() {
            let t = line.trimmed
            if t.hasPrefix("["), t.hasSuffix(")]"), let call = parseBody(t), Toolbox.named(call.name) != nil {
                let prose = output.replacingOccurrences(of: String(line), with: "")
                return (prose.trimmed, call)
            }
        }
        return (output.trimmed, nil)
    }

    static func parseBody(_ raw: String) -> ToolCall? {
        var s = raw.trimmed
        if s.hasPrefix("{") { return parseJSON(s) }
        if s.hasPrefix("[") { s.removeFirst() }
        if s.hasSuffix("]") { s.removeLast() }
        return parsePythonic(s.trimmed)
    }

    static func parseJSON(_ s: String) -> ToolCall? {
        guard let data = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = obj["name"] as? String else { return nil }
        let rawArgs = (obj["args"] ?? obj["arguments"]) as? [String: Any] ?? [:]
        return ToolCall(name: name, args: rawArgs.mapValues { "\($0)" })
    }

    /// `name(key="value", other='v', n=3)`
    static func parsePythonic(_ s: String) -> ToolCall? {
        guard let open = s.firstIndex(of: "("), s.hasSuffix(")") else { return nil }
        let name = s[..<open].trimmed
        guard !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
        let inner = Array(s[s.index(after: open)..<s.index(before: s.endIndex)])
        var args: [String: String] = [:]
        var i = 0
        func skipSpace() { while i < inner.count, inner[i] == " " || inner[i] == "," || inner[i] == "\n" { i += 1 } }
        while true {
            skipSpace()
            guard i < inner.count else { break }
            var key = ""
            while i < inner.count, inner[i] != "=" { key.append(inner[i]); i += 1 }
            guard i < inner.count else { break }
            i += 1 // '='
            skipSpace()
            var value = ""
            if i < inner.count, inner[i] == "\"" || inner[i] == "'" {
                let quote = inner[i]; i += 1
                while i < inner.count, inner[i] != quote {
                    if inner[i] == "\\", i + 1 < inner.count {
                        i += 1
                        switch inner[i] {
                        case "n": value.append("\n")
                        case "t": value.append("\t")
                        default: value.append(inner[i])
                        }
                    } else {
                        value.append(inner[i])
                    }
                    i += 1
                }
                i += 1
            } else {
                while i < inner.count, inner[i] != "," { value.append(inner[i]); i += 1 }
                value = value.trimmed
            }
            args[key.trimmed] = value
        }
        return ToolCall(name: name, args: args)
    }
}

extension StringProtocol {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
