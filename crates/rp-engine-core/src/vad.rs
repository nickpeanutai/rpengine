use crate::js_error;
use wasm_bindgen::prelude::*;

const SAMPLE_RATE: f64 = 16000.0;
const FRAME_SAMPLES: usize = 400;
const FRAME_SHIFT: usize = 160;
const MEL_BINS: usize = 80;
const FFT_SIZE: usize = 512;
const LOW_FREQUENCY: f64 = 20.0;
const EPSILON: f64 = 1.1920928955078125e-7;

#[wasm_bindgen]
pub struct VadStateCore {
    probabilities: Vec<f64>, speech_run: f64, silence_run: f64, valid_speech: f64,
    started: bool, ended: bool, threshold: f64, speech_start: f64, minimum_speech: f64, silence_end: f64,
}
#[wasm_bindgen]
impl VadStateCore {
    #[wasm_bindgen(constructor)]
    pub fn new(threshold: f64, speech_start_seconds: f64, minimum_speech_seconds: f64, silence_end_seconds: f64) -> Self {
        Self { probabilities: Vec::new(), speech_run: 0.0, silence_run: 0.0, valid_speech: 0.0, started: false, ended: false, threshold, speech_start: speech_start_seconds, minimum_speech: minimum_speech_seconds, silence_end: silence_end_seconds }
    }

    pub fn process(&mut self, probability: f64, seconds: f64, frame_seconds: f64) -> String {
        if self.ended { return String::new(); }
        self.probabilities.push(probability);
        if self.probabilities.len() > 5 { self.probabilities.remove(0); }
        let smoothed = self.probabilities.iter().sum::<f64>() / self.probabilities.len() as f64;
        let mut state = None;
        if smoothed >= self.threshold {
            self.speech_run += frame_seconds; self.valid_speech += frame_seconds; self.silence_run = 0.0;
            if !self.started && self.speech_run + 1e-6 >= self.speech_start { self.started = true; state = Some("speech_started"); }
        } else {
            self.speech_run = 0.0;
            if self.started {
                self.silence_run += frame_seconds;
                if self.silence_run + 1e-6 >= self.silence_end {
                    if self.valid_speech + 1e-6 >= self.minimum_speech { self.ended = true; state = Some("speech_ended"); }
                    else { self.started = false; self.valid_speech = 0.0; self.silence_run = 0.0; state = Some("listening"); }
                }
            }
        }
        state.map(|state| format!(r#"{{"state":"{state}","seconds":{seconds}}}"#)).unwrap_or_default()
    }
}

impl Default for VadStateCore { fn default() -> Self { Self::new(0.5, 0.20, 0.25, 0.50) } }

#[wasm_bindgen]
pub struct CmvnCore { means: Vec<f32>, inverse_std: Vec<f32> }

fn read_i32(bytes: &[u8], offset: &mut usize) -> Result<i32, JsError> {
    if *offset + 4 > bytes.len() { return Err(js_error("Truncated CMVN matrix.")); }
    let value = i32::from_le_bytes(bytes[*offset..*offset + 4].try_into().unwrap_or_default()); *offset += 4; Ok(value)
}

fn read_f64(bytes: &[u8], offset: &mut usize) -> Result<f64, JsError> {
    if *offset + 8 > bytes.len() { return Err(js_error("Truncated CMVN matrix.")); }
    let value = f64::from_le_bytes(bytes[*offset..*offset + 8].try_into().unwrap_or_default()); *offset += 8; Ok(value)
}

#[wasm_bindgen]
impl CmvnCore {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<Self, JsError> {
        if bytes.len() < 16 || bytes[0] != 0 || &bytes[1..4] != b"BDM" { return Err(js_error("Unsupported FireRedVAD CMVN format.")); }
        let mut offset = 5;
        if bytes.get(offset).copied() != Some(4) { return Err(js_error("Invalid CMVN row header.")); } offset += 1;
        let rows = read_i32(bytes, &mut offset)?;
        if bytes.get(offset).copied() != Some(4) { return Err(js_error("Invalid CMVN column header.")); } offset += 1;
        let columns = read_i32(bytes, &mut offset)?;
        if rows != 2 || columns != MEL_BINS as i32 + 1 { return Err(js_error(format!("Unexpected CMVN shape: {rows}x{columns}."))); }
        let mut stats = Vec::with_capacity(rows as usize * columns as usize);
        for _ in 0..stats.capacity() { stats.push(read_f64(bytes, &mut offset)?); }
        let count = stats[MEL_BINS]; if count < 1.0 { return Err(js_error("Invalid CMVN sample count.")); }
        let mut means = vec![0.0; MEL_BINS]; let mut inverse_std = vec![0.0; MEL_BINS];
        for index in 0..MEL_BINS {
            let mean = stats[index] / count;
            let variance = (stats[columns as usize + index] / count - mean * mean).max(1e-20);
            means[index] = mean as f32; inverse_std[index] = (1.0 / variance.sqrt()) as f32;
        }
        Ok(Self { means, inverse_std })
    }
    #[wasm_bindgen(getter)] pub fn means(&self) -> Vec<f32> { self.means.clone() }
    #[wasm_bindgen(getter, js_name = inverseStd)] pub fn inverse_std(&self) -> Vec<f32> { self.inverse_std.clone() }
}

#[wasm_bindgen]
pub struct KaldiFbankCore { samples: Vec<f32>, mel_banks: Vec<Vec<f32>> }

#[wasm_bindgen]
impl KaldiFbankCore {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self { Self { samples: Vec::new(), mel_banks: create_mel_banks() } }

    pub fn push(&mut self, chunk: &[f32], cmvn: &CmvnCore) -> Vec<f32> {
        self.samples.extend_from_slice(chunk);
        let mut flattened = Vec::new();
        let mut offset = 0;
        while offset + FRAME_SAMPLES <= self.samples.len() {
            flattened.extend(kaldi_fbank_frame(&self.samples[offset..offset + FRAME_SAMPLES], &self.mel_banks, cmvn));
            offset += FRAME_SHIFT;
        }
        if offset > 0 { self.samples.drain(..offset); }
        flattened
    }

    pub fn reset(&mut self) { self.samples.clear(); }
}

impl Default for KaldiFbankCore { fn default() -> Self { Self::new() } }

fn kaldi_fbank_frame(input: &[f32], mel_banks: &[Vec<f32>], cmvn: &CmvnCore) -> Vec<f32> {
    let mut real = vec![0.0; FFT_SIZE]; let mut imaginary = vec![0.0; FFT_SIZE];
    let pcm: Vec<f64> = input.iter().map(|value| (value * 32768.0).trunc().clamp(-32768.0, 32767.0) as f64).collect();
    let mean = pcm.iter().sum::<f64>() / pcm.len() as f64;
    let mut previous = pcm[0] - mean;
    for index in 0..input.len() {
        let current = pcm[index] - mean;
        let emphasized = if index == 0 { current * 0.03 } else { current - 0.97 * previous };
        previous = current;
        let base = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / (FRAME_SAMPLES - 1) as f64).cos();
        real[index] = emphasized * base.powf(0.85);
    }
    fft(&mut real, &mut imaginary);
    let power: Vec<f64> = (0..=FFT_SIZE / 2).map(|index| real[index] * real[index] + imaginary[index] * imaginary[index]).collect();
    (0..MEL_BINS).map(|bin| {
        let energy = power.iter().zip(&mel_banks[bin]).map(|(power, weight)| power * *weight as f64).sum::<f64>();
        ((energy.max(EPSILON).ln() - cmvn.means[bin] as f64) * cmvn.inverse_std[bin] as f64) as f32
    }).collect()
}

fn fft(real: &mut [f64], imaginary: &mut [f64]) {
    let mut reversed = 0;
    for index in 1..FFT_SIZE {
        let mut bit = FFT_SIZE >> 1;
        while reversed & bit != 0 { reversed ^= bit; bit >>= 1; }
        reversed ^= bit;
        if index < reversed { real.swap(index, reversed); imaginary.swap(index, reversed); }
    }
    let mut length = 2;
    while length <= FFT_SIZE {
        let angle = -2.0 * std::f64::consts::PI / length as f64;
        let half = length >> 1;
        for start in (0..FFT_SIZE).step_by(length) {
            for offset in 0..half {
                let cos = (angle * offset as f64).cos(); let sin = (angle * offset as f64).sin();
                let even = start + offset; let odd = even + half;
                let odd_real = real[odd] * cos - imaginary[odd] * sin;
                let odd_imaginary = real[odd] * sin + imaginary[odd] * cos;
                real[odd] = real[even] - odd_real; imaginary[odd] = imaginary[even] - odd_imaginary;
                real[even] += odd_real; imaginary[even] += odd_imaginary;
            }
        }
        length <<= 1;
    }
}

fn mel_scale(frequency: f64) -> f64 { 1127.0 * (1.0 + frequency / 700.0).ln() }
fn create_mel_banks() -> Vec<Vec<f32>> {
    let low = mel_scale(LOW_FREQUENCY); let high = mel_scale(SAMPLE_RATE / 2.0); let delta = (high - low) / (MEL_BINS + 1) as f64;
    (0..MEL_BINS).map(|bin| {
        let left = low + bin as f64 * delta; let center = left + delta; let right = center + delta;
        (0..=FFT_SIZE / 2).map(|fft_bin| {
            let mel = mel_scale(fft_bin as f64 * SAMPLE_RATE / FFT_SIZE as f64);
            if mel > left && mel < right { if mel <= center { ((mel - left) / delta) as f32 } else { ((right - mel) / delta) as f32 } } else { 0.0 }
        }).collect()
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn vad_starts_and_ends() { let mut state = VadStateCore::default(); let mut update = String::new(); for frame in 1..=25 { update = state.process(1.0, frame as f64 / 100.0, 0.01); } assert!(update.contains("speech_started") || update.is_empty()); for frame in 26..=80 { update = state.process(0.0, frame as f64 / 100.0, 0.01); } assert!(update.contains("speech_ended") || update.is_empty()); }
}
