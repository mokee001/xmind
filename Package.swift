// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "EchooEngine",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "EchooCore", targets: ["EchooCore"]),
        .library(name: "EchooApple", targets: ["EchooApple"]),
        .library(name: "EchooGateway", targets: ["EchooGateway"]),
        .executable(name: "echoo-audit", targets: ["EchooAudit"]),
        .executable(name: "echoo-calibrate", targets: ["EchooCalibrate"])
    ],
    targets: [
        .target(name: "EchooCore"),
        .target(name: "EchooApple", dependencies: ["EchooCore"], resources: [.copy("Resources/BlueSky")]),
        .target(name: "EchooGateway", dependencies: ["EchooCore"]),
        .executableTarget(name: "EchooAudit", dependencies: ["EchooCore", "EchooApple", "EchooGateway"]),
        .executableTarget(name: "EchooCalibrate", dependencies: ["EchooCore", "EchooApple", "EchooGateway"]),
        .testTarget(name: "EchooCoreTests", dependencies: ["EchooCore"]),
        .testTarget(name: "EchooAppleTests", dependencies: ["EchooApple", "EchooCore"]),
        .testTarget(name: "EchooGatewayTests", dependencies: ["EchooGateway", "EchooCore"])
    ]
)
