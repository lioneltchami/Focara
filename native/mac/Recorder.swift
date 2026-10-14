import Foundation
import ScreenCaptureKit
import AVFoundation
import AppKit
import QuartzCore

// macOS capture helper for Odak (derived from Kadraj's recorder).
// Screen: ScreenCaptureKit with the system cursor hidden, encoded to H.264 MP4.
// Cursor: polled at 120 Hz + click monitors, stamped with the same host clock as the frames.
// Audio: system audio and microphone written as separate, timestamp-aligned 16-bit WAV files.

struct RecordOptions {
    var out: URL
    var fps = 60
    var displayID: CGDirectDisplayID
    var excludePID: pid_t?
    var systemAudio = false
    var microphone = false
}

struct RecordResult {
    var duration: Double
    var width: Int
    var height: Int
    var pixelsPerPoint: Double
    var systemAudio: String?
    var microphone: String?
}

enum HelperError: Error, CustomStringConvertible {
    case permission, display, noFrames, writer(String)
    var description: String {
        switch self {
        case .permission: "Ekran kaydı izni yok."
        case .display: "Seçilen ekran bulunamadı."
        case .noFrames: "Kayıt sırasında hiç görüntü alınamadı."
        case .writer(let m): "Dosya yazılamadı: \(m)"
        }
    }
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private var stream: SCStream?
    private let videoQueue = DispatchQueue(label: "odak.video", qos: .userInitiated)
    private let audioQueue = DispatchQueue(label: "odak.audio", qos: .userInitiated)
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var systemWav: WavWriter?
    private var micWav: WavWriter?
    private var firstPTS: CMTime?
    private var lastSample: CMSampleBuffer?
    private var stopped = false
    private(set) var failure: Error?
    private let cursor = CursorRecorder()
    private var displayFrame = CGRect.zero
    private var pixelsPerPoint = 2.0
    private var size = CGSize.zero
    var onFailure: ((Error) -> Void)?

    func start(_ o: RecordOptions) async throws {
        let content: SCShareableContent
        do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
        catch { throw CGPreflightScreenCaptureAccess() ? error : HelperError.permission }
        guard let display = content.displays.first(where: { $0.displayID == o.displayID }) else { throw HelperError.display }
        let exclude = content.applications.filter { $0.processID == o.excludePID || $0.processID == getpid() }
        let filter = SCContentFilter(display: display, excludingApplications: exclude, exceptingWindows: [])

        // H.264 everywhere (decodable on every Windows PC too): fit within 4096×2304.
        let points = filter.contentRect.size
        let native = Double(filter.pointPixelScale)
        let fit = min(1, 4096 / (points.width * native), 2304 / (points.height * native))
        let w = (Int(points.width * native * fit) / 2) * 2, h = (Int(points.height * native * fit) / 2) * 2
        size = CGSize(width: w, height: h)
        pixelsPerPoint = Double(w) / points.width
        displayFrame = NSScreen.screens.first { $0.displayID == o.displayID }?.frame
            ?? CGRect(origin: .zero, size: points)

        let config = SCStreamConfiguration()
        config.width = w; config.height = h
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(o.fps))
        config.showsCursor = false
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.colorSpaceName = CGColorSpace.sRGB
        config.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        config.queueDepth = 8
        config.capturesAudio = o.systemAudio
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        if #available(macOS 15.0, *) { config.captureMicrophone = o.microphone }

        let writer = try AVAssetWriter(outputURL: o.out.appendingPathComponent("screen.mp4"), fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
            AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                                        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                                        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: min(60_000_000, max(10_000_000, w * h * o.fps / 12)),
                AVVideoExpectedSourceFrameRateKey: o.fps,
                AVVideoMaxKeyFrameIntervalKey: o.fps,
                AVVideoAllowFrameReorderingKey: false,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ]])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw HelperError.writer("video") }
        writer.add(input)
        self.writer = writer; self.input = input
        if o.systemAudio { systemWav = WavWriter(url: o.out.appendingPathComponent("system.wav")) }
        if o.microphone, #available(macOS 15.0, *) { micWav = WavWriter(url: o.out.appendingPathComponent("mic.wav")) }

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        if o.systemAudio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
        if o.microphone, #available(macOS 15.0, *) { try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: audioQueue) }
        self.stream = stream
        await MainActor.run { cursor.start() }
        do { try await stream.startCapture() }
        catch { await MainActor.run { cursor.stop() }; throw CGPreflightScreenCaptureAccess() ? error : HelperError.permission }
    }

    var hasFirstFrame: Bool { videoQueue.sync { firstPTS != nil } }

    /// Unix time (ms) of the first video frame — the zero point the app aligns camera and mic to.
    var firstFrameEpochMs: Double? {
        videoQueue.sync { firstPTS.map { Date().timeIntervalSince1970 * 1000 - (CACurrentMediaTime() - $0.seconds) * 1000 } }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sb.isValid, !stopped else { return }
        if type == .screen {
            guard let info = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
                  let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
                  let writer, let input else { return }
            let pts = sb.presentationTimeStamp
            if firstPTS == nil {
                guard writer.startWriting() else { failure = writer.error; return }
                writer.startSession(atSourceTime: pts)
                audioQueue.sync { firstPTS = pts }
            }
            if input.isReadyForMoreMediaData { input.append(sb) }
            lastSample = sb
        } else if let first = firstPTS {
            if type == .audio { systemWav?.append(sb, origin: first) }
            else if #available(macOS 15.0, *), type == .microphone { micWav?.append(sb, origin: first) }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { failure = error; onFailure?(error) }

    func stop() async throws -> (RecordResult, CursorTrack) {
        let endHost = CMClockGetTime(CMClockGetHostTimeClock())
        let (first, last): (CMTime?, CMSampleBuffer?) = videoQueue.sync { stopped = true; return (firstPTS, lastSample) }
        audioQueue.sync {}
        try? await stream?.stopCapture()
        stream = nil
        let raw = await MainActor.run { () -> CursorRecorder.Raw in cursor.stop(); return cursor.raw }
        guard let first, let writer, let input else { writer?.cancelWriting(); throw failure ?? HelperError.noFrames }
        // A still screen produces no frames: repeat the last one at the stop time so the video
        // is as long as the audio and cursor data.
        if let last, endHost > last.presentationTimeStamp,
           let copy = try? CMSampleBuffer(copying: last, withNewTiming: [
               CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: endHost, decodeTimeStamp: .invalid)]) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
            input.append(copy)
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: endHost)
        await writer.finishWriting()
        guard writer.status == .completed else { throw HelperError.writer(writer.error?.localizedDescription ?? "?") }
        let duration = (endHost - first).seconds
        let systemName = systemWav?.finish(duration: duration) == true ? systemWav?.url.lastPathComponent : nil
        let micName = micWav?.finish(duration: duration) == true ? micWav?.url.lastPathComponent : nil
        let track = raw.track(firstHostTime: first.seconds, duration: duration, displayFrame: displayFrame,
                              scale: pixelsPerPoint, pixelSize: size)
        return (RecordResult(duration: duration, width: Int(size.width), height: Int(size.height),
                             pixelsPerPoint: pixelsPerPoint, systemAudio: systemName, microphone: micName), track)
    }
}

/// 16-bit PCM WAV with timestamp alignment: sample 0 is the first video frame; gaps are filled
/// with silence and overlaps dropped, so the file stays in sync however the stream delivers.
final class WavWriter {
    let url: URL
    private var handle: FileHandle?
    private var rate = 48_000.0
    private var channels = 2
    private var frames: Int64 = 0

    init(url: URL) { self.url = url }

    func append(_ sb: CMSampleBuffer, origin: CMTime) {
        guard let fmt = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee else { return }
        if handle == nil {
            rate = asbd.mSampleRate
            channels = Int(asbd.mChannelsPerFrame)
            FileManager.default.createFile(atPath: url.path, contents: header(dataBytes: 0))
            handle = try? FileHandle(forWritingTo: url)
            _ = try? handle?.seekToEnd()
        }
        guard let handle, asbd.mFormatID == kAudioFormatLinearPCM else { return }
        var blockBuffer: CMBlockBuffer?
        var sizeNeeded = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil,
            bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        let abl = AudioBufferList.allocate(maximumBuffers: max(channels, 1))
        defer { free(abl.unsafeMutablePointer) }
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: nil,
            bufferListOut: abl.unsafeMutablePointer, bufferListSize: sizeNeeded, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil, flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer) == noErr else { return }
        let count = CMSampleBufferGetNumSamples(sb)
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        func sample(_ ch: Int, _ i: Int) -> Float {
            let buf = nonInterleaved ? abl[min(ch, abl.count - 1)] : abl[0]
            let idx = nonInterleaved ? i : i * channels + ch
            guard let p = buf.mData else { return 0 }
            return isFloat ? p.assumingMemoryBound(to: Float.self)[idx]
                           : Float(p.assumingMemoryBound(to: Int16.self)[idx]) / 32768
        }
        // Where this buffer belongs on the recording timeline.
        let start = Int64(((sb.presentationTimeStamp - origin).seconds * rate).rounded())
        var skip = 0
        if start > frames { writeSilence(Int(start - frames)) }          // gap
        else if start < frames { skip = Int(frames - start) }              // overlap
        guard skip < count else { return }
        var out = [Int16](repeating: 0, count: (count - skip) * channels)
        for i in skip..<count {
            for ch in 0..<channels {
                out[(i - skip) * channels + ch] = Int16(max(-1, min(1, sample(ch, i))) * 32767)
            }
        }
        out.withUnsafeBytes { handle.write(Data($0)) }
        frames += Int64(count - skip)
    }

    private func writeSilence(_ n: Int) {
        guard n > 0, let handle else { return }
        handle.write(Data(count: n * channels * 2))
        frames += Int64(n)
    }

    /// Pads to the recording length and fixes the header. Returns false if nothing was recorded.
    func finish(duration: Double) -> Bool {
        guard let handle else { return false }
        let target = Int64((duration * rate).rounded())
        if target > frames { writeSilence(Int(target - frames)) }
        try? handle.seek(toOffset: 0)
        handle.write(header(dataBytes: Int(frames) * channels * 2))
        try? handle.close()
        return true
    }

    private func header(dataBytes: Int) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + dataBytes)); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(UInt16(channels)); u32(UInt32(rate))
        u32(UInt32(rate) * UInt32(channels) * 2); u16(UInt16(channels * 2)); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(UInt32(dataBytes))
        return d
    }
}

struct CursorSample: Codable { var t: Double; var x: Double; var y: Double }
struct ClickEvent: Codable { var t: Double; var x: Double; var y: Double; var isDown: Bool; var button: Int }
struct CursorTrack: Codable { var samples: [CursorSample] = []; var clicks: [ClickEvent] = [] }

/// Polls the pointer at 120 Hz and listens for clicks, stamping both with host time.
@MainActor
final class CursorRecorder {
    struct Raw {
        var samples: [(t: Double, p: CGPoint)] = []
        var clicks: [(t: Double, p: CGPoint, down: Bool, button: Int)] = []

        func track(firstHostTime t0: Double, duration: Double, displayFrame f: CGRect, scale: Double, pixelSize: CGSize) -> CursorTrack {
            func px(_ p: CGPoint) -> (Double, Double) {
                (min(max((p.x - f.minX) * scale, 0), pixelSize.width), min(max((f.maxY - p.y) * scale, 0), pixelSize.height))
            }
            var out = CursorTrack()
            var before: CursorSample?
            for s in samples {
                let (x, y) = px(s.p), t = s.t - t0
                if t < 0 { before = CursorSample(t: 0, x: x, y: y); continue }
                if t > duration { break }
                if out.samples.isEmpty, let b = before, t > 0 { out.samples.append(b) }
                out.samples.append(CursorSample(t: t, x: x, y: y))
            }
            if out.samples.isEmpty, let b = before { out.samples.append(b) }
            out.clicks = clicks.compactMap { c in
                let t = c.t - t0
                guard t >= 0, t <= duration else { return nil }
                let (x, y) = px(c.p)
                return ClickEvent(t: t, x: x, y: y, isDown: c.down, button: c.button)
            }
            return out
        }
    }

    private(set) var raw = Raw()
    private var timer: Timer?
    private var monitors: [Any] = []
    nonisolated init() {}

    func start() {
        raw = Raw()
        record()
        let t = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.record() } }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp]
        if let g = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] e in
            let host = CACurrentMediaTime() - (ProcessInfo.processInfo.systemUptime - e.timestamp)
            let down = e.type == .leftMouseDown || e.type == .rightMouseDown
            let button = (e.type == .rightMouseDown || e.type == .rightMouseUp) ? 1 : 0
            MainActor.assumeIsolated { self?.raw.clicks.append((host, NSEvent.mouseLocation, down, button)) }
        }) { monitors.append(g) }
    }

    private func record() {
        let p = NSEvent.mouseLocation
        if let last = raw.samples.last, last.p == p, CACurrentMediaTime() - last.t < 0.25 { return }
        raw.samples.append((CACurrentMediaTime(), p))
    }

    func stop() {
        timer?.invalidate(); timer = nil
        monitors.forEach { NSEvent.removeMonitor($0) }; monitors = []
        record()
    }
}

extension NSScreen {
    var displayID: CGDirectDisplayID? { (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value }
}
