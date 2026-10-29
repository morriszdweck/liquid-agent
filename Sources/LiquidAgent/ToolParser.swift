import Foundation

/// Parses tool calls from small-model output. Accepts LFM's native pythonic
/// form `<|tool_call_start|>[shell(cmd="ls")]<|tool_call_end|>`, the same call
/// without special tokens, the XML form LFM3 also emits
/// (`<tool_call><function=shell><parameter=cmd>ls</parameter></function></tool_call>`),
/// and a JSON fallback `{"name":..,"args":{..}}`.
enum ToolParser {
    static let start = "<|tool_call_start|>"
    static let end = "<|tool_call_end|>"
    static let xmlStart = "<tool_call>"
    static let xmlEnd = "</tool_call>"
    /// Stop strings for the model server.
    static let stops = [end, xmlEnd]

    /// Text to show while streaming: everything before a tool call starts.
    static func visible(_ raw: String) -> String {
        [start, xmlStart, "<function="].reduce(raw) { $0.components(separatedBy: $1).first ?? $0 }
    }

    /// Returns the text before the call and the call itself, if any.
    static func parse(_ output: String) -> (prose: String, call: ToolCall?) {
        let result = parseRaw(output)
        return (result.prose, result.call.map(normalize))
    }

    /// Repairs common small-model slips: `function=shell(cmd="ls")` as the
    /// name, or a parameter named differently from the tool's signature.
    static func normalize(_ call: ToolCall) -> ToolCall {
        var call = call
        if call.name.contains("("), let inline = parsePythonic(call.name.hasSuffix(")") ? call.name : call.name + ")") {
            call = ToolCall(name: inline.name, args: inline.args.filter { !$0.value.isEmpty }.merging(call.args) { $1 })
        }
        if let open = call.name.firstIndex(of: "(") { call.name = call.name[..<open].trimmed }
        guard let tool = Toolbox.named(call.name) else { return call }
        let expected = tool.params
        let unknown = call.args.keys.filter { !expected.contains($0) }
        let missing = expected.filter { call.args[$0] == nil }
        if unknown.count == 1, missing.count == 1, let key = unknown.first, let target = missing.first {
            call.args[target] = call.args.removeValue(forKey: key)
        }
        return call
    }

    private static func parseRaw(_ output: String) -> (prose: String, call: ToolCall?) {
        if let range = output.range(of: start) {
            let prose = String(output[..<range.lowerBound])
            var body = String(output[range.upperBound...])
            if let endRange = body.range(of: end) { body = String(body[..<endRange.lowerBound]) }
            return (prose.trimmed, parseBody(body))
        }
        if let range = output.range(of: xmlStart) ?? output.range(of: "<function=") {
            let prose = String(output[..<range.lowerBound])
            return (prose.trimmed, parseXML(String(output[range.lowerBound...])))
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

    /// `<function=name><parameter=key>value</parameter></function>`
    static func parseXML(_ s: String) -> ToolCall? {
        guard let fn = s.range(of: "<function=") else { return nil }
        let afterName = s[fn.upperBound...]
        guard let close = afterName.firstIndex(of: ">") else { return nil }
        let name = afterName[..<close].trimmed
        guard !name.isEmpty else { return nil }
        var args: [String: String] = [:]
        var rest = afterName[afterName.index(after: close)...]
        while let p = rest.range(of: "<parameter=") {
            let tail = rest[p.upperBound...]
            guard let keyEnd = tail.firstIndex(of: ">") else { break }
            let key = tail[..<keyEnd].trimmed
            let valueStart = tail.index(after: keyEnd)
            let valueEnd = tail.range(of: "</parameter>")?.lowerBound
                ?? tail.range(of: "<parameter=")?.lowerBound
                ?? tail.range(of: "</function>")?.lowerBound
                ?? tail.endIndex
            args[key] = tail[valueStart..<valueEnd].trimmingCharacters(in: .newlines)
            rest = tail[valueEnd...]
        }
        return ToolCall(name: name, args: args)
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
