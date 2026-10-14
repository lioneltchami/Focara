import Foundation
import AppKit
import ScreenCaptureKit

// odak-capture (macOS). Protocol shared with the Windows helper:
//   odak-capture record --out DIR --fps 60 --display-id N [--exclude-pid P] [--system-audio] [--mic]
//   stdout: one JSON object per line: {"event":"started"} … {"event":"finished", …} or {"event":"error", …}
//   stdin:  "stop\n" ends the recording (EOF does too, e.g. when the app quits).
//   odak-capture permission [--request]  -> {"event":"permission","granted":bool}

func emit(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
        print(s); fflush(stdout)
    }
}

func fail(_ err: Error) -> Never {
    let permission = (err as? HelperError).map { if case .permission = $0 { return true } else { return false } } ?? false
    emit(["event": "error", "message": "\(err)", "code": permission ? "permission" : "error"])
    exit(1)
}

let args = CommandLine.arguments
func value(_ name: String) -> String? { args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }

switch args.dropFirst().first {
case "permission":
    let granted = args.contains("--request") ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
    emit(["event": "permission", "granted": granted])
    exit(0)
case "record":
    guard let out = value("--out"), let id = value("--display-id").flatMap(UInt32.init) else {
        emit(["event": "error", "message": "eksik argüman"]); exit(2)
    }
    let options = RecordOptions(out: URL(fileURLWithPath: out), fps: value("--fps").flatMap(Int.init) ?? 60,
                                displayID: id, excludePID: value("--exclude-pid").flatMap(Int32.init),
                                systemAudio: args.contains("--system-audio"), microphone: args.contains("--mic"))
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let recorder = Recorder()
    let stopping = ManagedAtomicFlag()

    @Sendable func finish() {
        guard stopping.setOnce() else { return }
        Task {
            do {
                let (r, track) = try await recorder.stop()
                let cursorURL = options.out.appendingPathComponent("cursor.json")
                try JSONEncoder().encode(track).write(to: cursorURL, options: .atomic)
                emit(["event": "finished", "video": "screen.mp4", "cursor": "cursor.json",
                      "systemAudio": r.systemAudio ?? NSNull(), "microphone": r.microphone ?? NSNull(),
                      "duration": r.duration, "width": r.width, "height": r.height, "pixelsPerPoint": r.pixelsPerPoint])
                exit(0)
            } catch { fail(error) }
        }
    }
    recorder.onFailure = { _ in finish() }

    Task {
        do {
            try await recorder.start(options)
            // Report "started" once the first frame is in the file.
            for _ in 0..<500 where !recorder.hasFirstFrame { try await Task.sleep(nanoseconds: 10_000_000) }
            guard recorder.hasFirstFrame else { throw HelperError.noFrames }
            emit(["event": "started", "t0": recorder.firstFrameEpochMs ?? Date().timeIntervalSince1970 * 1000])
        } catch { fail(error) }
    }
    Thread {
        while let line = readLine() { if line.trimmingCharacters(in: .whitespaces) == "stop" { break } }
        finish()
    }.start()
    app.run()
default:
    emit(["event": "error", "message": "kullanım: odak-capture record|permission"])
    exit(2)
}

final class ManagedAtomicFlag: @unchecked Sendable {
    private var done = false
    private let lock = NSLock()
    func setOnce() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}
