import Foundation
import AVFoundation
import CoreVideo

// Writes synthetic frames with the helper's real H.264 settings and a screen-like variable frame
// rate (bursts at 60 fps, long still stretches with a frame every 0.7 s), then reads the file back:
// key frames must never be more than ~1 s apart, so the editor can seek and cut quickly.
@main struct KeyframeTest {
    static func frame(_ w: Int, _ h: Int, _ i: Int) -> CVPixelBuffer {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                            [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &pb)
        let b = pb!
        CVPixelBufferLockBaseAddress(b, [])
        for plane in 0..<CVPixelBufferGetPlaneCount(b) {
            let base = CVPixelBufferGetBaseAddressOfPlane(b, plane)!.assumingMemoryBound(to: UInt8.self)
            let n = CVPixelBufferGetBytesPerRowOfPlane(b, plane) * CVPixelBufferGetHeightOfPlane(b, plane)
            for k in stride(from: 0, to: n, by: 97) { base[k] = UInt8((k / 97 + i * 7) & 0xff) }
        }
        CVPixelBufferUnlockBaseAddress(b, [])
        return b
    }

    static func main() throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("keyframetest.mp4")
        try? FileManager.default.removeItem(at: url)
        let (w, h, fps) = (1920, 1080, 60)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: Recorder.videoSettings(width: w, height: h, fps: fps))
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { print("FAIL: writer refuses the helper's video settings"); exit(1) }
        writer.add(input)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h])
        guard writer.startWriting() else { print("FAIL: \(writer.error.map { "\($0)" } ?? "startWriting")"); exit(1) }
        writer.startSession(atSourceTime: .zero)
        var times: [Double] = []
        var t = 0.0
        for burst in 0..<3 {
            for _ in 0..<90 { times.append(t); t += 1.0 / 60 }        // 1.5 s of motion
            for _ in 0..<6 { t += 0.7; times.append(t) }               // 4.2 s mostly still
            t += 1.0 / 60
            _ = burst
        }
        for (i, s) in times.enumerated() {
            while !input.isReadyForMoreMediaData { usleep(1000) }
            adaptor.append(frame(w, h, i), withPresentationTime: CMTime(seconds: s, preferredTimescale: 600))
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        guard writer.status == .completed else { print("FAIL: \(writer.error.map { "\($0)" } ?? "write")"); exit(1) }

        let asset = AVURLAsset(url: url)
        let track = asset.tracks(withMediaType: .video)[0] // sync API is fine in a test
        let reader = try AVAssetReader(asset: asset)
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(out)
        reader.startReading()
        var keys: [Double] = []
        while let sb = out.copyNextSampleBuffer() {
            let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
            let notSync = (att?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false
            if !notSync { keys.append(CMSampleBufferGetPresentationTimeStamp(sb).seconds) }
        }
        let gaps = zip(keys.dropFirst(), keys).map { $0 - $1 }
        let worst = gaps.max() ?? 0
        print("frames \(times.count), key frames \(keys.count), largest key frame gap \(String(format: "%.2f", worst)) s")
        if worst > 1.45 { print("FAIL: key frames too far apart"); exit(1) }
        print("PASS")
    }
}
