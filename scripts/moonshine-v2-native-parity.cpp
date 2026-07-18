#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include "moonshine-streaming-model.h"

static std::vector<float> read_pcm16_wav(const std::string &path) {
  std::ifstream input(path, std::ios::binary);
  input.seekg(0, std::ios::end);
  const size_t size = static_cast<size_t>(input.tellg());
  input.seekg(0);
  std::vector<uint8_t> bytes(size);
  input.read(reinterpret_cast<char *>(bytes.data()), size);
  size_t offset = 12;
  size_t data_offset = 0;
  uint32_t data_size = 0;
  while (offset + 8 <= bytes.size()) {
    const std::string tag(reinterpret_cast<const char *>(bytes.data() + offset), 4);
    uint32_t chunk_size = 0;
    std::memcpy(&chunk_size, bytes.data() + offset + 4, 4);
    if (tag == "data") { data_offset = offset + 8; data_size = chunk_size; break; }
    offset += 8 + chunk_size + (chunk_size & 1);
  }
  std::vector<float> samples(data_size / 2);
  for (size_t index = 0; index < samples.size(); ++index) {
    int16_t value = 0;
    std::memcpy(&value, bytes.data() + data_offset + index * 2, 2);
    samples[index] = static_cast<float>(value) / 32768.0f;
  }
  return samples;
}

static void print_json_string(const std::string &text) {
  std::cout << '"';
  for (const unsigned char value : text) {
    if (value == '\\' || value == '"') std::cout << '\\' << value;
    else if (value == '\n') std::cout << "\\n";
    else if (value == '\r') std::cout << "\\r";
    else if (value == '\t') std::cout << "\\t";
    else std::cout << value;
  }
  std::cout << '"';
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  const std::string model_directory = argv[1];
  const std::vector<float> samples = read_pcm16_wav(argv[2]);
  MoonshineStreamingModel model(false);
  if (model.load(model_directory.c_str(), (model_directory + "/tokenizer.bin").c_str(), 4) != 0) return 3;
  MoonshineStreamingState *state = model.create_state();
  constexpr size_t chunk_size = 1'280;
  for (size_t offset = 0; offset + chunk_size <= samples.size(); offset += chunk_size) {
    if (model.process_audio_chunk(state, samples.data() + offset, chunk_size, nullptr) != 0) return 4;
  }
  int new_frames = 0;
  if (model.encode(state, true, &new_frames) != 0) return 5;
  model.decoder_reset(state);
  const int max_tokens = std::min(static_cast<int>(std::ceil(samples.size() / 16'000.0 * 6.5)), 256);
  std::vector<int64_t> tokens{model.config.bos_id};
  std::vector<float> logits(model.config.vocab_size);
  int current = model.config.bos_id;
  for (int step = 0; step < max_tokens; ++step) {
    if (model.decode_step(state, current, logits.data()) != 0) return 6;
    const int next = static_cast<int>(std::max_element(logits.begin(), logits.end()) - logits.begin());
    tokens.push_back(next);
    current = next;
    if (next == model.config.eos_id) break;
  }
  std::cout << "{\"tokenIds\":[";
  for (size_t index = 0; index < tokens.size(); ++index) { if (index) std::cout << ','; std::cout << tokens[index]; }
  std::cout << "],\"text\":";
  print_json_string(model.tokens_to_text(tokens));
  std::cout << "}\n";
  delete state;
  return 0;
}
