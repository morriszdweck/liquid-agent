import SwiftUI

/// Liquid Agent's mascot: a glossy circle with two simple eyes that blink,
/// look around and react to what the agent is doing.
struct Mascot: View {
    var mood: MascotMood
    var size: CGFloat = 64
    var level: Float = 0

    @State private var blink = false
    @State private var look: CGSize = .zero
    @State private var bob = false

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(colors: [tint.opacity(0.95), tint.opacity(0.65), .black.opacity(0.85)],
                                   center: .init(x: 0.35, y: 0.3), startRadius: 1, endRadius: size * 0.75)
                )
                .overlay(
                    Circle().fill(.white.opacity(0.25))
                        .frame(width: size * 0.28, height: size * 0.16)
                        .blur(radius: size * 0.04)
                        .offset(x: -size * 0.18, y: -size * 0.28)
                )
                .shadow(color: tint.opacity(0.45), radius: size * 0.18)
                .scaleEffect(1 + CGFloat(level) * 0.08)

            HStack(spacing: size * 0.2) {
                eye
                eye
            }
            .offset(x: look.width, y: look.height - size * 0.04)
        }
        .frame(width: size, height: size)
        .offset(y: bob ? -size * 0.03 : size * 0.03)
        .animation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true), value: bob)
        .animation(.spring(response: 0.35, dampingFraction: 0.7), value: look)
        .animation(.easeInOut(duration: 0.3), value: mood)
        .onAppear { bob = true }
        .task { await blinkLoop() }
        .task(id: mood) { await lookLoop() }
        .accessibilityLabel("Liquid Agent mascot, \(String(describing: mood))")
    }

    private var eye: some View {
        Capsule()
            .fill(.white)
            .frame(width: size * 0.12, height: eyeHeight)
            .shadow(color: .white.opacity(0.6), radius: 2)
    }

    private var eyeHeight: CGFloat {
        if blink { return size * 0.025 }
        switch mood {
        case .happy: return size * 0.1
        case .alert: return size * 0.3
        case .listening: return size * 0.26
        case .thinking, .working: return size * 0.16
        case .error: return size * 0.06
        default: return size * 0.22
        }
    }

    private var tint: Color {
        switch mood {
        case .idle, .happy: Color(red: 0.25, green: 0.55, blue: 1.0)
        case .thinking: Color(red: 0.45, green: 0.4, blue: 1.0)
        case .working: Color(red: 0.1, green: 0.75, blue: 0.85)
        case .listening: Color(red: 0.2, green: 0.8, blue: 0.5)
        case .speaking: Color(red: 0.35, green: 0.65, blue: 1.0)
        case .alert: Color(red: 1.0, green: 0.65, blue: 0.2)
        case .error: Color(red: 0.95, green: 0.3, blue: 0.35)
        }
    }

    private func blinkLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(Double.random(in: 2.5...5.5)))
            withAnimation(.easeIn(duration: 0.07)) { blink = true }
            try? await Task.sleep(for: .milliseconds(110))
            withAnimation(.easeOut(duration: 0.1)) { blink = false }
        }
    }

    private func lookLoop() async {
        let r = size * 0.06
        while !Task.isCancelled {
            switch mood {
            case .thinking:
                look = CGSize(width: r, height: -r)
                try? await Task.sleep(for: .milliseconds(700))
                look = CGSize(width: -r, height: -r)
                try? await Task.sleep(for: .milliseconds(700))
            case .working:
                look = CGSize(width: CGFloat.random(in: -r...r), height: r * 0.5)
                try? await Task.sleep(for: .milliseconds(350))
            case .alert, .listening:
                look = .zero
                try? await Task.sleep(for: .seconds(1))
            default:
                look = CGSize(width: CGFloat.random(in: -r...r), height: CGFloat.random(in: -r * 0.5...r * 0.5))
                try? await Task.sleep(for: .seconds(Double.random(in: 1.5...3.5)))
            }
        }
    }
}
