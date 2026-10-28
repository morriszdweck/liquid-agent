// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "LiquidAgent",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "LiquidAgent",
            path: "Sources/LiquidAgent"
        )
    ]
)
