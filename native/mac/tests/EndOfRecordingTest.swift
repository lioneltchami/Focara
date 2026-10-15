import Foundation
import AVFoundation
import CoreVideo

// A still screen at the end of a recording: the last frame arrived 1.2 s before "stop". The
// helper's finishVideo must make the video end exactly at the stop time — not earlier (the
// audio and cursor data run until then) and not later.
@main struct EndOfRecordingTest {
    static func frame(_ w: Int, _ h: Int, _ i: Int) -> CVPixelBuffer {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &pb)
        CVPixelBufferLockBaseAddress(pb!, [])
        let base = CVPixelBufferGetBaseAddressOfPlane(pb!, 0)!.assumingMemoryBound(to: UInt8.self)
        for k in stride(from: 0, to: CVPixelBufferGetBytesPerRowOfPlane(pb!, 0) * h, by: 61) { base[k] = UInt8((k + i * 13) & 0xff) }
        CVPixelBufferUnlockBaseAddress(pb!, [])
        return pb!
    }

    static func main() async throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("endtest.mp4")
        try? FileManager.default.removeItem(at: url)
        let (w, h, fps) = (1280, 720, 60)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: Recorder.videoSettings(width: w, height: h, fps: fps))
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        guard writer.startWriting() else { print("FAIL: startWriting"); exit(1) }
        let start = CMTime(seconds: 100, preferredTimescale: 600)
        writer.startSession(atSourceTime: start)
        var desc: CMVideoFormatDescription?
        var last: CMSampleBuffer?
        for i in 0..<110 {                                 // 1.8 s of motion…
            let pb = frame(w, h, i)
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pb, formatDescriptionOut: &desc)
            var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: start + CMTime(value: CMTimeValue(i * 10), timescale: 600), decodeTimeStamp: .invalid)
            var sb: CMSampleBuffer?
            CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pb, formatDescription: desc!, sampleTiming: &timing, sampleBufferOut: &sb)
            while !input.isReadyForMoreMediaData { usleep(1000) }
            input.append(sb!)
            last = sb
        }
        let end = start + CMTime(seconds: 3.0, preferredTimescale: 600)   // …then 1.2 s still, then stop
        try await Recorder.finishVideo(writer: writer, input: input, last: last, end: end, fps: fps)
        guard writer.status == .completed else { print("FAIL: \(writer.error.map { "\($0)" } ?? "write")"); exit(1) }

        let asset = AVURLAsset(url: url)
        let track = try await asset.loadTracks(withMediaType: .video)[0]
        // The sample table, as other players and the editor read it (edit lists aside): the last
        // frame's start plus its own duration.
        guard let cursor = track.makeSampleCursorAtLastSampleInDecodeOrder() else { print("FAIL: no samples"); exit(1) }
        let lastPts = cursor.presentationTimeStamp.seconds, lastEnd = lastPts + cursor.currentSampleDuration.seconds
        print(String(format: "last frame at %.3f s, lasting until %.3f s (stop at 3.000 s)", lastPts, lastEnd))
        if abs(lastEnd - 3.0) > 0.02 { print("FAIL: video does not end at the stop time"); exit(1) }
        print("PASS")
    }
}
