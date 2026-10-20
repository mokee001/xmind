import Foundation
import UniformTypeIdentifiers
import CryptoKit
import EchooCore
import EchooApple
import EchooGateway

/// Local development harness only. No hard-coded library, no source writes, no vendor keys.
@main
struct EchooAudit {
    static func main() async {
        do {
            try await run()
        } catch {
            // Never print provider responses, OCR strings, or secrets.
            FileHandle.standardError.write(Data("Audit failed: \(type(of: error))\n".utf8))
            exit(1)
        }
    }

    static func run() async throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let path = arguments.first, path != "--help" else {
            print("Usage: echoo-audit <folder> [--limit <n>] [--gateway <url>] [--output <json>]")
            print("Default: local evidence only; unresolved photos remain pending. No cloud calls.")
            return
        }
        func value(_ flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
            return arguments[index + 1]
        }
        let limit = value("--limit").flatMap(Int.init) ?? 20
        guard limit > 0 else { throw CLIError.invalidArguments }
        var gateway: HTTPAnalysisGateway?
        if let endpoint = value("--gateway") {
            guard let url = URL(string: endpoint),
                  let token = ProcessInfo.processInfo.environment["ECHOO_GATEWAY_SESSION_TOKEN"],
                  !token.isEmpty else { throw CLIError.invalidArguments }
            gateway = try HTTPAnalysisGateway(
                baseURL: url, allowLocalHTTP: true, sessionToken: { token }
            )
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
        let files = try FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        ).filter {
            let resource = try? $0.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            return resource?.isRegularFile == true && resource?.isSymbolicLink != true
        }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        let engine = PhotoAnalysisEngine(nativeAnalyzer: AppleNativeAnalyzer(), remoteAnalyzer: gateway)
        var results: [PhotoAnalysisResult] = []
        for file in files.prefix(limit) {
            let identifier = SHA256.hash(data: Data(file.lastPathComponent.utf8))
                .map { String(format: "%02x", $0) }.joined()
            let type = UTType(filenameExtension: file.pathExtension)
            // LaunchServices type lookup can be unavailable in a CLI sandbox.
            // These are metadata hints only: decoding and admission still follow.
            let ext = file.pathExtension.lowercased()
            let kind: MediaKind = type?.conforms(to: .image) == true ||
                ["jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "webp", "dng"].contains(ext) ? .image :
                type?.conforms(to: .movie) == true || ["mov", "mp4", "m4v"].contains(ext) ? .video : .other
            let input = PhotoInput(id: identifier, mediaKind: kind)
            results.append(await engine.process(input, source: FilePhotoSource(url: file)))
        }
        let report = AuditReport(
            schemaVersion: "echoo-audit-v1", policyVersion: engine.policy.version,
            mode: gateway == nil ? "native-only" : "gateway",
            results: results, albums: ThemeAlbum.assemble(from: results)
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(report)
        if let output = value("--output") {
            let destination = URL(fileURLWithPath: output).standardizedFileURL
            // Prevent the harness from overwriting source material or placing outputs inside the library.
            guard !destination.path.hasPrefix(directory.path + "/"), destination != directory else {
                throw CLIError.unsafeOutput
            }
            guard !FileManager.default.fileExists(atPath: destination.path) else {
                throw CLIError.unsafeOutput
            }
            try data.write(to: destination, options: [.withoutOverwriting])
        } else {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
    }
}

private enum CLIError: Error { case invalidArguments, unsafeOutput }
private struct AuditReport: Encodable {
    let schemaVersion: String
    let policyVersion: String
    let mode: String
    let results: [PhotoAnalysisResult]
    let albums: [ThemeAlbum]
}
