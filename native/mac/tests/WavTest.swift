import Foundation
import AVFoundation

// Feeds synthetic float32 non-interleaved stereo buffers (the format ScreenCaptureKit delivers)
// with a gap and an overlap into WavWriter and checks the resulting timeline.
@main struct WavTest {
    static func buffer(start: Double, frames: Int, value: Float) -> CMSampleBuffer {
        var asbd = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsNonInterleaved | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
        var fmt: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &fmt)
        let pcm = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(streamDescription: &asbd)!, frameCapacity: AVAudioFrameCount(frames))!
        pcm.frameLength = AVAudioFrameCount(frames)
        for ch in 0..<2 { for i in 0..<frames { pcm.floatChannelData![ch][i] = value } }
        var sb: CMSampleBuffer?
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: CMTime(seconds: 100 + start, preferredTimescale: 48000), decodeTimeStamp: .invalid)
        CMSampleBufferCreate(allocator: nil, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil, formatDescription: fmt, sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sb)
        CMSampleBufferSetDataBufferFromAudioBufferList(sb!, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, bufferList: pcm.audioBufferList)
        CMSampleBufferSetDataReady(sb!)
        return sb!
    }
    static func main() {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("wavtest.wav")
        let w = WavWriter(url: url)
        let origin = CMTime(seconds: 100, preferredTimescale: 48000)
        w.append(buffer(start: 0.010, frames: 4800, value: 0.5), origin: origin)   // starts 10 ms late -> 480 frames silence
        w.append(buffer(start: 0.110, frames: 4800, value: -0.5), origin: origin)  // contiguous
        w.append(buffer(start: 0.200, frames: 4800, value: 0.25), origin: origin)  // overlaps by 10 ms -> first 480 dropped
        _ = w.finish(duration: 1.0)
        let d = try! Data(contentsOf: url)
        let samples = d.dropFirst(44).withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        let frames = samples.count / 2
        func at(_ f: Int) -> Int16 { samples[f * 2] }
        var ok = true
        func check(_ c: Bool, _ m: String) { print(c ? "PASS: \(m)" : "FAIL: \(m)"); ok = ok && c }
        check(frames == 48000, "padded to recording length (\(frames) frames)")
        check(at(479) == 0 && at(480) == 16383, "late start filled with exactly 10 ms of silence")
        check(at(5279) == 16383 && at(5280) == -16383, "contiguous buffer follows without gap")
        check(at(10079) == -16383 && at(10080) == 8191, "overlapping 10 ms dropped, next buffer lands at 210 ms")
        check(at(14399) == 8191 && at(14400) == 0, "buffer ends at 300 ms, tail padded with silence")
        exit(ok ? 0 : 1)
    }
}
