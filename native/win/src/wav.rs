//! 16-bit PCM WAV writer with timeline alignment (same rules as the macOS helper):
//! frame 0 is the first video frame; gaps are filled with silence, overlaps are dropped.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub struct WavWriter {
    pub path: PathBuf,
    file: File,
    rate: u32,
    channels: u16,
    frames: i64,
}

impl WavWriter {
    pub fn create(path: &Path, rate: u32, channels: u16) -> std::io::Result<Self> {
        let mut file = File::create(path)?;
        file.write_all(&header(rate, channels, 0))?;
        Ok(Self { path: path.to_path_buf(), file, rate, channels, frames: 0 })
    }

    /// `start` is the timeline frame where `samples` (interleaved f32) begins.
    pub fn append(&mut self, start: i64, samples: &[f32]) -> std::io::Result<()> {
        let ch = self.channels as usize;
        let count = (samples.len() / ch) as i64;
        let mut skip = 0i64;
        if start > self.frames { self.silence(start - self.frames)?; }
        else if start < self.frames { skip = self.frames - start; }
        if skip >= count { return Ok(()); }
        let mut out = Vec::with_capacity(((count - skip) as usize) * ch * 2);
        for &s in &samples[(skip as usize) * ch..(count as usize) * ch] {
            out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
        self.file.write_all(&out)?;
        self.frames += count - skip;
        Ok(())
    }

    fn silence(&mut self, n: i64) -> std::io::Result<()> {
        if n <= 0 { return Ok(()); }
        self.file.write_all(&vec![0u8; n as usize * self.channels as usize * 2])?;
        self.frames += n;
        Ok(())
    }

    /// Pads to the recording length and fixes the header.
    pub fn finish(mut self, duration: f64) -> std::io::Result<()> {
        let target = (duration * self.rate as f64).round() as i64;
        if target > self.frames { self.silence(target - self.frames)?; }
        let bytes = self.frames as u32 * self.channels as u32 * 2;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&header(self.rate, self.channels, bytes))?;
        self.file.flush()
    }
}

fn header(rate: u32, channels: u16, data_bytes: u32) -> Vec<u8> {
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&channels.to_le_bytes());
    h.extend_from_slice(&rate.to_le_bytes());
    h.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    h.extend_from_slice(&(channels * 2).to_le_bytes());
    h.extend_from_slice(&16u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data_bytes.to_le_bytes());
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aligns_like_the_mac_helper() {
        let path = std::env::temp_dir().join("odak-wav-test.wav");
        let mut w = WavWriter::create(&path, 48000, 2).unwrap();
        let block = |v: f32| vec![v; 4800 * 2];
        w.append(480, &block(0.5)).unwrap();      // 10 ms late -> silence first
        w.append(5280, &block(-0.5)).unwrap();    // contiguous
        w.append(9600, &block(0.25)).unwrap();    // overlaps 10 ms -> first 480 dropped
        w.finish(1.0).unwrap();
        let d = std::fs::read(&path).unwrap();
        let s: Vec<i16> = d[44..].chunks(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
        let at = |f: usize| s[f * 2];
        assert_eq!(s.len() / 2, 48000);
        assert_eq!((at(479), at(480)), (0, 16383));
        assert_eq!((at(5279), at(5280)), (16383, -16383));
        assert_eq!((at(10079), at(10080)), (-16383, 8191));
        assert_eq!((at(14399), at(14400)), (8191, 0));
    }
}
